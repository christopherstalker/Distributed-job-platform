package limits

import (
	"context"
	"fmt"
	"slices"
	"strconv"
	"time"

	"distributed-job-system/libs/backend/domain"
	"distributed-job-system/libs/backend/queue"

	"github.com/redis/go-redis/v9"
)

const acquireRateLua = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', tonumber(ARGV[1]) - tonumber(ARGV[3]))
local count = redis.call('ZCARD', KEYS[1])
if count < tonumber(ARGV[2]) then
	redis.call('ZADD', KEYS[1], tonumber(ARGV[1]), ARGV[4])
	redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]))
	return {1, 0, count + 1}
end
local next = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
if next[2] then
	return {0, tonumber(next[2]) + tonumber(ARGV[3]), count}
end
return {0, tonumber(ARGV[1]) + tonumber(ARGV[3]), count}
`

const releaseRateLua = `
redis.call('ZREM', KEYS[1], ARGV[1])
return 1
`

const acquireConcurrencyLua = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', tonumber(ARGV[1]))
local existing = redis.call('ZSCORE', KEYS[1], ARGV[4])
if existing then
	redis.call('ZADD', KEYS[1], tonumber(ARGV[1]) + tonumber(ARGV[3]), ARGV[4])
	redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]))
	return {1, 0, redis.call('ZCARD', KEYS[1])}
end
local count = redis.call('ZCARD', KEYS[1])
if count < tonumber(ARGV[2]) then
	redis.call('ZADD', KEYS[1], tonumber(ARGV[1]) + tonumber(ARGV[3]), ARGV[4])
	redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]))
	return {1, 0, count + 1}
end
local next = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
if next[2] then
	return {0, tonumber(next[2]), count}
end
return {0, tonumber(ARGV[1]) + tonumber(ARGV[3]), count}
`

const renewConcurrencyLua = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', tonumber(ARGV[1]))
if redis.call('ZSCORE', KEYS[1], ARGV[3]) then
	redis.call('ZADD', KEYS[1], tonumber(ARGV[1]) + tonumber(ARGV[2]), ARGV[3])
	redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]))
	return 1
end
return 0
`

const releaseConcurrencyLua = `
redis.call('ZREM', KEYS[1], ARGV[1])
return 1
`

type Decision struct {
	Allowed     bool
	RetryAt     time.Time
	Reasons     []domain.ThrottleReason
	activeRate  []acquiredRate
	activeSlots []acquiredSlot
}

type acquiredRate struct {
	policy domain.RateLimitPolicy
	member string
}

type acquiredSlot struct {
	policy domain.RateLimitPolicy
	member string
}

type RedisLimiter struct {
	client *redis.Client
}

func NewRedisLimiter(client *redis.Client) *RedisLimiter {
	return &RedisLimiter{client: client}
}

func (l *RedisLimiter) EvaluateAndAcquire(ctx context.Context, job domain.Job, policies []domain.RateLimitPolicy, leaseTTL time.Duration) (Decision, error) {
	now := time.Now().UTC()
	decision := Decision{Allowed: true}
	applicable := applicablePolicies(job, policies)
	for _, policy := range applicable {
		switch policy.Mode {
		case domain.RateLimitModeRate:
			member := fmt.Sprintf("%s:%d", job.ID, job.Attempts)
			allowed, retryAt, err := l.acquireRate(ctx, policy, member, now)
			if err != nil {
				l.rollback(ctx, decision)
				return Decision{}, err
			}
			if !allowed {
				decision.Allowed = false
				decision.RetryAt = maxTime(decision.RetryAt, retryAt)
				decision.Reasons = append(decision.Reasons, buildReason(policy, retryAt))
				continue
			}
			decision.activeRate = append(decision.activeRate, acquiredRate{policy: policy, member: member})
		case domain.RateLimitModeConcurrency:
			allowed, retryAt, err := l.acquireConcurrency(ctx, policy, job.ID, now, leaseTTL)
			if err != nil {
				l.rollback(ctx, decision)
				return Decision{}, err
			}
			if !allowed {
				decision.Allowed = false
				decision.RetryAt = maxTime(decision.RetryAt, retryAt)
				decision.Reasons = append(decision.Reasons, buildReason(policy, retryAt))
				continue
			}
			decision.activeSlots = append(decision.activeSlots, acquiredSlot{policy: policy, member: job.ID})
		}
	}

	if decision.Allowed {
		return decision, nil
	}

	l.rollback(ctx, decision)
	return decision, nil
}

func (l *RedisLimiter) Renew(ctx context.Context, job domain.Job, policies []domain.RateLimitPolicy, leaseTTL time.Duration) error {
	now := time.Now().UTC()
	for _, policy := range applicablePolicies(job, policies) {
		if policy.Mode != domain.RateLimitModeConcurrency {
			continue
		}
		if _, err := l.client.Eval(ctx, renewConcurrencyLua, []string{queue.RateLimitConcurrencyKey(policy.ID)}, now.UnixMilli(), leaseTTL.Milliseconds(), job.ID).Int(); err != nil {
			return err
		}
	}
	return nil
}

func (l *RedisLimiter) Release(ctx context.Context, job domain.Job, policies []domain.RateLimitPolicy) error {
	for _, policy := range applicablePolicies(job, policies) {
		if policy.Mode != domain.RateLimitModeConcurrency {
			continue
		}
		if _, err := l.client.Eval(ctx, releaseConcurrencyLua, []string{queue.RateLimitConcurrencyKey(policy.ID)}, job.ID).Int(); err != nil {
			return err
		}
	}
	return nil
}

func (l *RedisLimiter) Status(ctx context.Context, policies []domain.RateLimitPolicy) ([]domain.RateLimitStatus, error) {
	status := make([]domain.RateLimitStatus, 0, len(policies))
	now := time.Now().UTC()
	for _, policy := range policies {
		item := domain.RateLimitStatus{Policy: policy}
		switch policy.Mode {
		case domain.RateLimitModeConcurrency:
			key := queue.RateLimitConcurrencyKey(policy.ID)
			if _, err := l.client.ZRemRangeByScore(ctx, key, "-inf", fmt.Sprintf("%d", now.UnixMilli())).Result(); err != nil {
				return nil, err
			}
			count, err := l.client.ZCard(ctx, key).Result()
			if err != nil {
				return nil, err
			}
			item.ActiveCount = int(count)
			item.Throttled = item.ActiveCount >= policy.Limit
		case domain.RateLimitModeRate:
			key := queue.RateLimitRateKey(policy.ID)
			windowMillis := int64(policy.WindowSeconds) * int64(time.Second/time.Millisecond)
			if _, err := l.client.ZRemRangeByScore(ctx, key, "-inf", fmt.Sprintf("%d", now.UnixMilli()-windowMillis)).Result(); err != nil {
				return nil, err
			}
			count, err := l.client.ZCard(ctx, key).Result()
			if err != nil {
				return nil, err
			}
			item.RecentCount = int(count)
			item.Throttled = item.RecentCount >= policy.Limit
		}
		status = append(status, item)
	}
	slices.SortFunc(status, func(a, b domain.RateLimitStatus) int {
		switch {
		case a.Policy.Name < b.Policy.Name:
			return -1
		case a.Policy.Name > b.Policy.Name:
			return 1
		default:
			return 0
		}
	})
	return status, nil
}

func (l *RedisLimiter) rollback(ctx context.Context, decision Decision) {
	for _, acquired := range decision.activeRate {
		_, _ = l.client.Eval(ctx, releaseRateLua, []string{queue.RateLimitRateKey(acquired.policy.ID)}, acquired.member).Int()
	}
	for _, slot := range decision.activeSlots {
		_, _ = l.client.Eval(ctx, releaseConcurrencyLua, []string{queue.RateLimitConcurrencyKey(slot.policy.ID)}, slot.member).Int()
	}
}

func (l *RedisLimiter) acquireRate(ctx context.Context, policy domain.RateLimitPolicy, member string, now time.Time) (bool, time.Time, error) {
	windowMillis := int64(policy.WindowSeconds) * int64(time.Second/time.Millisecond)
	result, err := l.client.Eval(ctx, acquireRateLua, []string{queue.RateLimitRateKey(policy.ID)}, now.UnixMilli(), policy.Limit, windowMillis, member).Result()
	if err != nil {
		return false, time.Time{}, err
	}
	values := result.([]interface{})
	allowed := asInt64(values[0]) == 1
	retryAt := time.UnixMilli(asInt64(values[1])).UTC()
	return allowed, retryAt, nil
}

func (l *RedisLimiter) acquireConcurrency(ctx context.Context, policy domain.RateLimitPolicy, member string, now time.Time, leaseTTL time.Duration) (bool, time.Time, error) {
	result, err := l.client.Eval(ctx, acquireConcurrencyLua, []string{queue.RateLimitConcurrencyKey(policy.ID)}, now.UnixMilli(), policy.Limit, leaseTTL.Milliseconds(), member).Result()
	if err != nil {
		return false, time.Time{}, err
	}
	values := result.([]interface{})
	allowed := asInt64(values[0]) == 1
	retryAt := time.UnixMilli(asInt64(values[1])).UTC()
	return allowed, retryAt, nil
}

func applicablePolicies(job domain.Job, policies []domain.RateLimitPolicy) []domain.RateLimitPolicy {
	out := make([]domain.RateLimitPolicy, 0, len(policies))
	for _, policy := range policies {
		if !policy.Enabled {
			continue
		}
		switch policy.Scope {
		case domain.RateLimitScopeGlobal:
			out = append(out, policy)
		case domain.RateLimitScopeQueue:
			if policy.ScopeValue == job.Queue {
				out = append(out, policy)
			}
		case domain.RateLimitScopeJobType:
			if policy.ScopeValue == job.Type {
				out = append(out, policy)
			}
		case domain.RateLimitScopeTenant:
			if policy.ScopeValue == job.TenantID {
				out = append(out, policy)
			}
		}
	}
	return out
}

func buildReason(policy domain.RateLimitPolicy, retryAt time.Time) domain.ThrottleReason {
	return domain.ThrottleReason{
		PolicyID:   policy.ID,
		PolicyName: policy.Name,
		Scope:      policy.Scope,
		Mode:       policy.Mode,
		RetryAt:    retryAt,
		Message:    fmt.Sprintf("%s %s limit hit", policy.Scope, policy.Mode),
	}
}

func maxTime(current, candidate time.Time) time.Time {
	if current.IsZero() || candidate.After(current) {
		return candidate
	}
	return current
}

func asInt64(value interface{}) int64 {
	switch typed := value.(type) {
	case int64:
		return typed
	case int:
		return int64(typed)
	case float64:
		return int64(typed)
	case string:
		parsed, _ := strconv.ParseInt(typed, 10, 64)
		return parsed
	default:
		return 0
	}
}
