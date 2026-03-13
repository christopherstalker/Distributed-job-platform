package queue

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"distributed-job-system/libs/backend/domain"

	"github.com/redis/go-redis/v9"
)

const dequeueLua = `
for _, key in ipairs(KEYS) do
	local jobID = redis.call('LPOP', key)
	if jobID then
		local jobKey = ARGV[4] .. jobID
		if redis.call('EXISTS', jobKey) == 1 then
			local state = redis.call('HGET', jobKey, 'state')
			if state == 'queued' or state == 'retrying' or state == 'scheduled' then
				local leaseToken = redis.sha1hex(ARGV[1] .. ':' .. jobID .. ':' .. ARGV[3])
				local attempts = redis.call('HINCRBY', jobKey, 'attempts', 1)
				redis.call('HSET', jobKey,
					'state', 'active',
					'updated_at', ARGV[3],
					'started_at', ARGV[3],
					'last_heartbeat_at', ARGV[3],
					'lease_expires_at', tonumber(ARGV[3]) + tonumber(ARGV[2]),
					'worker_id', ARGV[1],
					'lease_token', leaseToken,
					'blocked_reason', '',
					'throttle_until', '')
				local leaseKey = ARGV[5] .. jobID
				redis.call('HSET', leaseKey,
					'job_id', jobID,
					'worker_id', ARGV[1],
					'lease_token', leaseToken,
					'acquired_at', ARGV[3],
					'last_heartbeat_at', ARGV[3],
					'lease_expires_at', tonumber(ARGV[3]) + tonumber(ARGV[2]))
				redis.call('PEXPIRE', leaseKey, tonumber(ARGV[2]))
				redis.call('ZADD', ARGV[6], tonumber(ARGV[3]) + tonumber(ARGV[2]), jobID)
				return {jobID, leaseToken, tostring(attempts)}
			end
		end
	end
end
return nil
`

const heartbeatLua = `
if redis.call('HGET', KEYS[1], 'lease_token') ~= ARGV[1] then
	return 0
end
if redis.call('HGET', KEYS[1], 'state') ~= 'active' then
	return 0
end
redis.call('HSET', KEYS[1], 'updated_at', ARGV[2], 'last_heartbeat_at', ARGV[2], 'lease_expires_at', tonumber(ARGV[2]) + tonumber(ARGV[3]))
redis.call('HSET', KEYS[2], 'worker_id', ARGV[5], 'last_heartbeat_at', ARGV[2], 'lease_expires_at', tonumber(ARGV[2]) + tonumber(ARGV[3]))
redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[3]))
redis.call('ZADD', KEYS[3], tonumber(ARGV[2]) + tonumber(ARGV[3]), ARGV[4])
return 1
`

const completeLua = `
if redis.call('HGET', KEYS[1], 'lease_token') ~= ARGV[1] then
	return 0
end
redis.call('DEL', KEYS[2])
redis.call('ZREM', KEYS[3], ARGV[2])
redis.call('HSET', KEYS[1],
	'state', 'completed',
	'updated_at', ARGV[3],
	'finished_at', ARGV[3],
	'worker_id', ARGV[5],
	'lease_token', '',
	'lease_expires_at', '',
	'throttle_until', '',
	'result', ARGV[4],
	'execution_ms', ARGV[6])
return 1
`

const failLua = `
if redis.call('HGET', KEYS[1], 'lease_token') ~= ARGV[1] then
	return 0
end
redis.call('DEL', KEYS[2])
redis.call('ZREM', KEYS[3], ARGV[2])
if ARGV[4] ~= '' then
	redis.call('HSET', KEYS[1],
		'state', 'retrying',
		'updated_at', ARGV[3],
		'last_error', ARGV[5],
		'next_run_at', ARGV[4],
		'run_at', ARGV[4],
		'worker_id', '',
		'lease_token', '',
		'lease_expires_at', '',
		'throttle_until', '')
	redis.call('ZADD', KEYS[4], tonumber(ARGV[4]), ARGV[2])
else
	redis.call('HSET', KEYS[1],
		'state', 'failed',
		'updated_at', ARGV[3],
		'finished_at', ARGV[3],
		'last_error', ARGV[5],
		'worker_id', '',
		'lease_token', '',
		'lease_expires_at', '',
		'throttle_until', '')
	redis.call('LPUSH', KEYS[5], ARGV[2])
end
return 1
`

const activateDueLua = `
local activated = {}
local jobIDs = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', tonumber(ARGV[1]), 'LIMIT', 0, tonumber(ARGV[2]))
for _, jobID in ipairs(jobIDs) do
	if redis.call('ZREM', KEYS[1], jobID) == 1 then
		local jobKey = ARGV[3] .. jobID
		if redis.call('EXISTS', jobKey) == 1 then
			local queueName = redis.call('HGET', jobKey, 'queue')
			local priority = redis.call('HGET', jobKey, 'priority')
			redis.call('HSET', jobKey,
				'state', 'queued',
				'updated_at', ARGV[1],
				'worker_id', '',
				'lease_token', '',
				'throttle_until', '',
				'lease_expires_at', '')
			redis.call('LPUSH', ARGV[4] .. queueName .. ':' .. priority, jobID)
			table.insert(activated, jobID)
		end
	end
end
return activated
`

const recoverExpiredLua = `
local recovered = {}
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', tonumber(ARGV[1]), 'LIMIT', 0, tonumber(ARGV[2]))
for _, jobID in ipairs(expired) do
	if redis.call('ZREM', KEYS[1], jobID) == 1 then
		local jobKey = ARGV[3] .. jobID
		local leaseKey = ARGV[4] .. jobID
		redis.call('DEL', leaseKey)
		if redis.call('EXISTS', jobKey) == 1 then
			local attempts = tonumber(redis.call('HGET', jobKey, 'attempts') or '0')
			local maxAttempts = tonumber(redis.call('HGET', jobKey, 'max_attempts') or '1')
			local queueName = redis.call('HGET', jobKey, 'queue') or 'default'
			if redis.call('HGET', jobKey, 'cancel_requested') == '1' then
				redis.call('HSET', jobKey,
					'state', 'canceled',
					'updated_at', ARGV[1],
					'finished_at', ARGV[1],
					'last_error', 'canceled while active',
					'worker_id', '',
					'lease_token', '',
					'lease_expires_at', '')
				table.insert(recovered, jobID .. '|canceled|0')
			elseif attempts < maxAttempts then
				local power = attempts - 1
				if power < 0 then
					power = 0
				end
				local delay = tonumber(ARGV[7]) * (2 ^ power)
				if delay > tonumber(ARGV[8]) then
					delay = tonumber(ARGV[8])
				end
				local retryAt = tonumber(ARGV[1]) + delay
				redis.call('HSET', jobKey,
					'state', 'retrying',
					'updated_at', ARGV[1],
					'last_error', 'lease expired',
					'next_run_at', retryAt,
					'run_at', retryAt,
					'worker_id', '',
					'lease_token', '',
					'lease_expires_at', '')
				redis.call('ZADD', KEYS[2], retryAt, jobID)
				table.insert(recovered, jobID .. '|retrying|' .. tostring(retryAt))
			else
				redis.call('HSET', jobKey,
					'state', 'failed',
					'updated_at', ARGV[1],
					'finished_at', ARGV[1],
					'last_error', 'lease expired',
					'worker_id', '',
					'lease_token', '',
					'lease_expires_at', '')
				redis.call('LPUSH', ARGV[5] .. queueName, jobID)
				table.insert(recovered, jobID .. '|failed|0')
			end
		end
	end
end
return recovered
`

const throttleLua = `
if redis.call('HGET', KEYS[1], 'lease_token') ~= ARGV[1] then
	return 0
end
redis.call('DEL', KEYS[2])
redis.call('ZREM', KEYS[3], ARGV[2])
redis.call('HSET', KEYS[1],
	'state', 'throttled',
	'updated_at', ARGV[3],
	'last_error', ARGV[4],
	'run_at', ARGV[5],
	'throttle_until', ARGV[5],
	'worker_id', '',
	'lease_token', '',
	'lease_expires_at', '')
redis.call('ZADD', KEYS[4], tonumber(ARGV[5]), ARGV[2])
return 1
`

type Broker interface {
	Enqueue(context.Context, domain.Job) error
	EnqueueBatch(context.Context, []domain.Job) error
	LoadJob(context.Context, string) (domain.Job, error)
	Dequeue(context.Context, string, []string, time.Duration) (*domain.LeasedJob, error)
	Heartbeat(context.Context, string, string, string, time.Duration) (bool, error)
	Complete(context.Context, domain.Job, string, []byte, time.Time) (bool, error)
	Fail(context.Context, domain.Job, string, string, *time.Time, time.Time) (bool, error)
	RequeueThrottled(context.Context, domain.Job, string, time.Time, string) (bool, error)
	ActivateDue(context.Context, int64, time.Time) ([]string, error)
	RecoverExpired(context.Context, int64, time.Time) ([]RecoveredLease, error)
	QueueLengths(context.Context, []string) (map[string]int64, int64, int64, error)
	Retry(context.Context, domain.Job, time.Time) error
	Cancel(context.Context, string) (bool, error)
}

type RecoveredLease struct {
	JobID   string
	State   domain.JobState
	RetryAt *time.Time
}

type RedisBroker struct {
	client         *redis.Client
	log            *slog.Logger
	baseRetryDelay time.Duration
	maxRetryDelay  time.Duration
}

func NewRedisBroker(client *redis.Client, log *slog.Logger, baseRetryDelay, maxRetryDelay time.Duration) *RedisBroker {
	return &RedisBroker{
		client:         client,
		log:            log,
		baseRetryDelay: baseRetryDelay,
		maxRetryDelay:  maxRetryDelay,
	}
}

func NewClient(addr, password string, db int) *redis.Client {
	return redis.NewClient(&redis.Options{
		Addr:     addr,
		Password: password,
		DB:       db,
	})
}

func (b *RedisBroker) Enqueue(ctx context.Context, job domain.Job) error {
	pipe := b.client.TxPipeline()
	pipe.HSet(ctx, JobKey(job.ID), jobHash(job))
	switch {
	case job.State == domain.JobStateBlocked:
	case job.State == domain.JobStateScheduled || job.State == domain.JobStateRetrying || job.State == domain.JobStateThrottled || job.RunAt.After(time.Now()):
		pipe.ZAdd(ctx, DelayedKey(), redis.Z{Score: float64(job.RunAt.UnixMilli()), Member: job.ID})
	case job.State == domain.JobStateQueued:
		pipe.LPush(ctx, ReadyKey(job.Queue, job.Priority), job.ID)
	}
	_, err := pipe.Exec(ctx)
	return err
}

func (b *RedisBroker) EnqueueBatch(ctx context.Context, jobs []domain.Job) error {
	if len(jobs) == 0 {
		return nil
	}
	pipe := b.client.TxPipeline()
	now := time.Now()
	for _, job := range jobs {
		pipe.HSet(ctx, JobKey(job.ID), jobHash(job))
		switch {
		case job.State == domain.JobStateBlocked:
		case job.State == domain.JobStateScheduled || job.State == domain.JobStateRetrying || job.State == domain.JobStateThrottled || job.RunAt.After(now):
			pipe.ZAdd(ctx, DelayedKey(), redis.Z{Score: float64(job.RunAt.UnixMilli()), Member: job.ID})
		case job.State == domain.JobStateQueued:
			pipe.LPush(ctx, ReadyKey(job.Queue, job.Priority), job.ID)
		}
	}
	_, err := pipe.Exec(ctx)
	return err
}

func (b *RedisBroker) LoadJob(ctx context.Context, jobID string) (domain.Job, error) {
	values, err := b.client.HGetAll(ctx, JobKey(jobID)).Result()
	if err != nil {
		return domain.Job{}, err
	}
	if len(values) == 0 {
		return domain.Job{}, redis.Nil
	}
	return jobFromHash(values)
}

func (b *RedisBroker) Dequeue(ctx context.Context, workerID string, queues []string, leaseTTL time.Duration) (*domain.LeasedJob, error) {
	keys := readyKeysForQueues(queues)
	result, err := b.client.Eval(ctx, dequeueLua, keys, workerID, leaseTTL.Milliseconds(), time.Now().UnixMilli(), jobKeyPrefix, leaseKeyPrefix, ActiveLeasesKey()).Result()
	if err != nil {
		if err == redis.Nil {
			return nil, nil
		}
		return nil, err
	}
	if result == nil {
		return nil, nil
	}
	values, ok := result.([]interface{})
	if !ok || len(values) < 2 {
		return nil, nil
	}
	jobID := fmt.Sprintf("%v", values[0])
	leaseToken := fmt.Sprintf("%v", values[1])
	job, err := b.LoadJob(ctx, jobID)
	if err != nil {
		return nil, err
	}
	job.LeaseToken = leaseToken
	return &domain.LeasedJob{Job: job, LeaseToken: leaseToken}, nil
}

func (b *RedisBroker) Heartbeat(ctx context.Context, jobID, leaseToken, workerID string, leaseTTL time.Duration) (bool, error) {
	result, err := b.client.Eval(ctx, heartbeatLua, []string{JobKey(jobID), LeaseKey(jobID), ActiveLeasesKey()}, leaseToken, time.Now().UnixMilli(), leaseTTL.Milliseconds(), jobID, workerID).Int()
	return result == 1, err
}

func (b *RedisBroker) Complete(ctx context.Context, job domain.Job, leaseToken string, result []byte, finishedAt time.Time) (bool, error) {
	res, err := b.client.Eval(
		ctx,
		completeLua,
		[]string{JobKey(job.ID), LeaseKey(job.ID), ActiveLeasesKey()},
		leaseToken,
		job.ID,
		finishedAt.UnixMilli(),
		string(result),
		job.WorkerID,
		job.ExecutionMs,
	).Int()
	return res == 1, err
}

func (b *RedisBroker) Fail(ctx context.Context, job domain.Job, leaseToken, errMessage string, retryAt *time.Time, failedAt time.Time) (bool, error) {
	retryValue := ""
	if retryAt != nil {
		retryValue = strconv.FormatInt(retryAt.UnixMilli(), 10)
	}
	res, err := b.client.Eval(
		ctx,
		failLua,
		[]string{JobKey(job.ID), LeaseKey(job.ID), ActiveLeasesKey(), DelayedKey(), DLQKey(job.Queue)},
		leaseToken,
		job.ID,
		failedAt.UnixMilli(),
		retryValue,
		errMessage,
	).Int()
	return res == 1, err
}

func (b *RedisBroker) RequeueThrottled(ctx context.Context, job domain.Job, leaseToken string, retryAt time.Time, reason string) (bool, error) {
	res, err := b.client.Eval(
		ctx,
		throttleLua,
		[]string{JobKey(job.ID), LeaseKey(job.ID), ActiveLeasesKey(), DelayedKey()},
		leaseToken,
		job.ID,
		time.Now().UnixMilli(),
		reason,
		retryAt.UnixMilli(),
	).Int()
	return res == 1, err
}

func (b *RedisBroker) ActivateDue(ctx context.Context, limit int64, now time.Time) ([]string, error) {
	result, err := b.client.Eval(ctx, activateDueLua, []string{DelayedKey()}, now.UnixMilli(), limit, jobKeyPrefix, "jobs:ready:").Result()
	if err != nil {
		return nil, err
	}
	return interfaceSliceToStrings(result), nil
}

func (b *RedisBroker) RecoverExpired(ctx context.Context, limit int64, now time.Time) ([]RecoveredLease, error) {
	result, err := b.client.Eval(
		ctx,
		recoverExpiredLua,
		[]string{ActiveLeasesKey(), DelayedKey()},
		now.UnixMilli(),
		limit,
		jobKeyPrefix,
		leaseKeyPrefix,
		"jobs:dlq:",
		"jobs:ready:",
		b.baseRetryDelay.Milliseconds(),
		b.maxRetryDelay.Milliseconds(),
	).Result()
	if err != nil {
		return nil, err
	}
	items := interfaceSliceToStrings(result)
	out := make([]RecoveredLease, 0, len(items))
	for _, item := range items {
		parts := strings.Split(item, "|")
		if len(parts) < 3 {
			continue
		}
		record := RecoveredLease{
			JobID: parts[0],
			State: domain.JobState(parts[1]),
		}
		if parts[2] != "0" {
			parsed, parseErr := strconv.ParseInt(parts[2], 10, 64)
			if parseErr == nil {
				retryAt := time.UnixMilli(parsed).UTC()
				record.RetryAt = &retryAt
			}
		}
		out = append(out, record)
	}
	return out, nil
}

func (b *RedisBroker) QueueLengths(ctx context.Context, queues []string) (map[string]int64, int64, int64, error) {
	if len(queues) == 0 {
		queues = domain.SupportedQueues
	}
	pipe := b.client.Pipeline()
	results := make(map[string][]*redis.IntCmd, len(queues))
	for _, queueName := range queues {
		for priority := 9; priority >= 0; priority-- {
			results[queueName] = append(results[queueName], pipe.LLen(ctx, ReadyKey(queueName, priority)))
		}
	}
	delayedCmd := pipe.ZCard(ctx, DelayedKey())
	activeCmd := pipe.ZCard(ctx, ActiveLeasesKey())
	if _, err := pipe.Exec(ctx); err != nil {
		return nil, 0, 0, err
	}
	queueLengths := make(map[string]int64, len(results))
	for queueName, cmds := range results {
		var total int64
		for _, cmd := range cmds {
			total += cmd.Val()
		}
		queueLengths[queueName] = total
	}
	return queueLengths, delayedCmd.Val(), activeCmd.Val(), nil
}

func (b *RedisBroker) Retry(ctx context.Context, job domain.Job, now time.Time) error {
	pipe := b.client.TxPipeline()
	pipe.HSet(ctx, JobKey(job.ID), map[string]interface{}{
		"state":            string(domain.JobStateQueued),
		"queue":            job.Queue,
		"payload":          string(job.Payload),
		"priority":         job.Priority,
		"run_at":           job.RunAt.UnixMilli(),
		"attempts":         job.Attempts,
		"updated_at":       now.UnixMilli(),
		"started_at":       "",
		"finished_at":      "",
		"last_error":       "",
		"lease_token":      "",
		"worker_id":        "",
		"cancel_requested": 0,
		"result":           "",
		"blocked_reason":   "",
		"throttle_until":   "",
		"lease_expires_at": "",
	})
	if job.RunAt.After(now) {
		pipe.HSet(ctx, JobKey(job.ID), "state", string(domain.JobStateScheduled))
		pipe.ZAdd(ctx, DelayedKey(), redis.Z{Score: float64(job.RunAt.UnixMilli()), Member: job.ID})
	} else {
		pipe.LPush(ctx, ReadyKey(job.Queue, job.Priority), job.ID)
	}
	pipe.LRem(ctx, DLQKey(job.Queue), 0, job.ID)
	_, err := pipe.Exec(ctx)
	return err
}

func (b *RedisBroker) Cancel(ctx context.Context, jobID string) (bool, error) {
	job, err := b.LoadJob(ctx, jobID)
	if err != nil {
		return false, err
	}
	now := time.Now().UnixMilli()
	pipe := b.client.TxPipeline()
	pipe.HSet(ctx, JobKey(jobID), "cancel_requested", 1, "updated_at", now)
	switch job.State {
	case domain.JobStateQueued, domain.JobStateScheduled, domain.JobStateRetrying, domain.JobStateThrottled, domain.JobStateFailed, domain.JobStateBlocked:
		pipe.LRem(ctx, ReadyKey(job.Queue, job.Priority), 0, jobID)
		pipe.ZRem(ctx, DelayedKey(), jobID)
		pipe.LRem(ctx, DLQKey(job.Queue), 0, jobID)
		pipe.HSet(ctx, JobKey(jobID), "state", string(domain.JobStateCanceled), "finished_at", now, "lease_expires_at", "", "throttle_until", "")
	}
	_, err = pipe.Exec(ctx)
	if err != nil {
		return false, err
	}
	return true, nil
}

func jobHash(job domain.Job) map[string]interface{} {
	hash := map[string]interface{}{
		"id":                job.ID,
		"type":              job.Type,
		"queue":             job.Queue,
		"tenant_id":         job.TenantID,
		"payload":           string(job.Payload),
		"priority":          job.Priority,
		"attempts":          job.Attempts,
		"max_attempts":      job.MaxAttempts,
		"state":             string(job.State),
		"schema_version":    job.SchemaVersion,
		"idempotency_key":   job.IdempotencyKey,
		"workflow_id":       job.WorkflowID,
		"parent_job_id":     job.ParentJobID,
		"dependency_policy": string(job.DependencyPolicy.Normalize()),
		"blocked_reason":    job.BlockedReason,
		"created_at":        job.CreatedAt.UnixMilli(),
		"updated_at":        job.UpdatedAt.UnixMilli(),
		"run_at":            job.RunAt.UnixMilli(),
		"last_error":        job.LastError,
		"worker_id":         job.WorkerID,
		"lease_token":       job.LeaseToken,
		"timeout_seconds":   job.TimeoutSeconds,
		"cancel_requested":  boolToInt(job.CancelRequested),
		"execution_ms":      job.ExecutionMs,
	}
	if job.StartedAt != nil {
		hash["started_at"] = job.StartedAt.UnixMilli()
	} else {
		hash["started_at"] = ""
	}
	if job.FinishedAt != nil {
		hash["finished_at"] = job.FinishedAt.UnixMilli()
	} else {
		hash["finished_at"] = ""
	}
	if job.LastHeartbeatAt != nil {
		hash["last_heartbeat_at"] = job.LastHeartbeatAt.UnixMilli()
	} else {
		hash["last_heartbeat_at"] = ""
	}
	if job.LeaseExpiresAt != nil {
		hash["lease_expires_at"] = job.LeaseExpiresAt.UnixMilli()
	} else {
		hash["lease_expires_at"] = ""
	}
	if job.ThrottleUntil != nil {
		hash["throttle_until"] = job.ThrottleUntil.UnixMilli()
	} else {
		hash["throttle_until"] = ""
	}
	if len(job.Result) > 0 {
		hash["result"] = string(job.Result)
	} else {
		hash["result"] = ""
	}
	return hash
}

func jobFromHash(values map[string]string) (domain.Job, error) {
	job := domain.Job{
		ID:               values["id"],
		Type:             values["type"],
		Queue:            values["queue"],
		TenantID:         values["tenant_id"],
		Payload:          json.RawMessage(values["payload"]),
		Priority:         parseInt(values["priority"]),
		Attempts:         parseInt(values["attempts"]),
		MaxAttempts:      parseInt(values["max_attempts"]),
		State:            domain.JobState(values["state"]),
		SchemaVersion:    parseInt(values["schema_version"]),
		IdempotencyKey:   values["idempotency_key"],
		WorkflowID:       values["workflow_id"],
		ParentJobID:      values["parent_job_id"],
		DependencyPolicy: domain.DependencyFailurePolicy(values["dependency_policy"]).Normalize(),
		BlockedReason:    values["blocked_reason"],
		LastError:        values["last_error"],
		WorkerID:         values["worker_id"],
		LeaseToken:       values["lease_token"],
		TimeoutSeconds:   parseInt(values["timeout_seconds"]),
		CancelRequested:  values["cancel_requested"] == "1",
		ExecutionMs:      int64(parseInt(values["execution_ms"])),
	}
	job.CreatedAt = parseMillis(values["created_at"])
	job.UpdatedAt = parseMillis(values["updated_at"])
	job.RunAt = parseMillis(values["run_at"])
	if startedAt, ok := optionalMillis(values["started_at"]); ok {
		job.StartedAt = &startedAt
	}
	if finishedAt, ok := optionalMillis(values["finished_at"]); ok {
		job.FinishedAt = &finishedAt
	}
	if heartbeatAt, ok := optionalMillis(values["last_heartbeat_at"]); ok {
		job.LastHeartbeatAt = &heartbeatAt
	}
	if leaseExpiresAt, ok := optionalMillis(values["lease_expires_at"]); ok {
		job.LeaseExpiresAt = &leaseExpiresAt
	}
	if throttleUntil, ok := optionalMillis(values["throttle_until"]); ok {
		job.ThrottleUntil = &throttleUntil
	}
	if result := values["result"]; result != "" {
		job.Result = json.RawMessage(result)
	}
	return job, nil
}

func readyKeysForQueues(queues []string) []string {
	if len(queues) == 0 {
		queues = domain.SupportedQueues
	}
	keys := make([]string, 0, len(queues)*10)
	for _, queueName := range queues {
		for priority := 9; priority >= 0; priority-- {
			keys = append(keys, ReadyKey(queueName, priority))
		}
	}
	return keys
}

func interfaceSliceToStrings(value interface{}) []string {
	raw, ok := value.([]interface{})
	if !ok {
		return nil
	}
	out := make([]string, 0, len(raw))
	for _, item := range raw {
		out = append(out, fmt.Sprintf("%v", item))
	}
	return out
}

func parseInt(value string) int {
	parsed, _ := strconv.Atoi(value)
	return parsed
}

func parseMillis(value string) time.Time {
	if value == "" {
		return time.Time{}
	}
	parsed, _ := strconv.ParseInt(value, 10, 64)
	return time.UnixMilli(parsed).UTC()
}

func optionalMillis(value string) (time.Time, bool) {
	if value == "" {
		return time.Time{}, false
	}
	return parseMillis(value), true
}

func boolToInt(value bool) int {
	if value {
		return 1
	}
	return 0
}
