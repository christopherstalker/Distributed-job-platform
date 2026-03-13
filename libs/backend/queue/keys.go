package queue

import "fmt"

const (
	delayedJobsKey         = "jobs:delayed"
	activeLeasesKey        = "jobs:leases"
	eventChannelKey        = "jobs:events"
	schedulerLeaderKey     = "scheduler:leader"
	scheduleDispatchPrefix = "scheduler:dispatch:"
	idempotencyCachePrefix = "idempotency:"
	rateLimitPrefix        = "limits:"
	jobKeyPrefix           = "job:"
	leaseKeyPrefix         = "lease:"
)

func ReadyKey(queueName string, priority int) string {
	return fmt.Sprintf("jobs:ready:%s:%d", queueName, priority)
}

func DLQKey(queueName string) string {
	return fmt.Sprintf("jobs:dlq:%s", queueName)
}

func JobKey(jobID string) string {
	return jobKeyPrefix + jobID
}

func LeaseKey(jobID string) string {
	return leaseKeyPrefix + jobID
}

func DelayedKey() string {
	return delayedJobsKey
}

func ActiveLeasesKey() string {
	return activeLeasesKey
}

func EventChannel() string {
	return eventChannelKey
}

func SchedulerLeaderKey() string {
	return schedulerLeaderKey
}

func ScheduleDispatchKey(scheduleID string, slot string) string {
	return scheduleDispatchPrefix + scheduleID + ":" + slot
}

func IdempotencyCacheKey(scope string) string {
	return idempotencyCachePrefix + scope
}

func RateLimitRateKey(policyID string) string {
	return rateLimitPrefix + "rate:" + policyID
}

func RateLimitConcurrencyKey(policyID string) string {
	return rateLimitPrefix + "concurrency:" + policyID
}
