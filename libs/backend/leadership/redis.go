package leadership

import (
	"context"
	"strconv"
	"time"

	"distributed-job-system/libs/backend/domain"
	"distributed-job-system/libs/backend/queue"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

const acquireLeaderLua = `
if redis.call('EXISTS', KEYS[1]) == 0 then
	redis.call('HSET', KEYS[1],
		'scheduler_id', ARGV[1],
		'token', ARGV[2],
		'acquired_at', ARGV[3],
		'last_heartbeat_at', ARGV[3],
		'lease_expires_at', ARGV[4])
	redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[5]))
	return 1
end
if redis.call('HGET', KEYS[1], 'token') == ARGV[2] then
	redis.call('HSET', KEYS[1],
		'last_heartbeat_at', ARGV[3],
		'lease_expires_at', ARGV[4])
	redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[5]))
	return 1
end
return 0
`

const releaseLeaderLua = `
if redis.call('HGET', KEYS[1], 'token') == ARGV[1] then
	return redis.call('DEL', KEYS[1])
end
return 0
`

type RedisLeaderElector struct {
	client *redis.Client
}

func NewRedisLeaderElector(client *redis.Client) *RedisLeaderElector {
	return &RedisLeaderElector{client: client}
}

func (e *RedisLeaderElector) TryAcquire(ctx context.Context, schedulerID string, leaseTTL time.Duration, currentToken string) (string, bool, error) {
	token := currentToken
	if token == "" {
		token = uuid.NewString()
	}
	now := time.Now().UTC()
	expiresAt := now.Add(leaseTTL)
	acquired, err := e.client.Eval(
		ctx,
		acquireLeaderLua,
		[]string{queue.SchedulerLeaderKey()},
		schedulerID,
		token,
		now.UnixMilli(),
		expiresAt.UnixMilli(),
		leaseTTL.Milliseconds(),
	).Int()
	if err != nil {
		return "", false, err
	}
	return token, acquired == 1, nil
}

func (e *RedisLeaderElector) Release(ctx context.Context, token string) error {
	if token == "" {
		return nil
	}
	_, err := e.client.Eval(ctx, releaseLeaderLua, []string{queue.SchedulerLeaderKey()}, token).Int()
	return err
}

func (e *RedisLeaderElector) Status(ctx context.Context) (domain.SchedulerLeaderStatus, error) {
	values, err := e.client.HGetAll(ctx, queue.SchedulerLeaderKey()).Result()
	if err != nil {
		return domain.SchedulerLeaderStatus{}, err
	}
	if len(values) == 0 {
		return domain.SchedulerLeaderStatus{}, nil
	}
	status := domain.SchedulerLeaderStatus{
		SchedulerID: values["scheduler_id"],
		Token:       values["token"],
	}
	if ts, ok := parseUnixMillis(values["acquired_at"]); ok {
		status.AcquiredAt = &ts
	}
	if ts, ok := parseUnixMillis(values["last_heartbeat_at"]); ok {
		status.LastHeartbeatAt = &ts
	}
	if ts, ok := parseUnixMillis(values["lease_expires_at"]); ok {
		status.LeaseExpiresAt = &ts
		status.IsLeaderHealthy = ts.After(time.Now().UTC())
	}
	return status, nil
}

func (e *RedisLeaderElector) ClaimScheduleDispatch(ctx context.Context, scheduleID string, slot time.Time, ttl time.Duration) (bool, error) {
	key := queue.ScheduleDispatchKey(scheduleID, slot.UTC().Format(time.RFC3339))
	return e.client.SetNX(ctx, key, slot.UTC().Format(time.RFC3339), ttl).Result()
}

func parseUnixMillis(value string) (time.Time, bool) {
	if value == "" {
		return time.Time{}, false
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return time.Time{}, false
	}
	return time.UnixMilli(parsed).UTC(), true
}
