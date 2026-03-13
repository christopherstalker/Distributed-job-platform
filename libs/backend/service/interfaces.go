package service

import (
	"context"
	"time"

	"distributed-job-system/libs/backend/domain"
	"distributed-job-system/libs/backend/queue"
)

type Repository interface {
	RunMigrations(context.Context, string) error
	CreateJobs(context.Context, []domain.Job) error
	CreateJobBundle(context.Context, domain.Job, []string) error
	CreateJobWithIdempotency(context.Context, domain.Job, []string, time.Duration) (domain.EnqueueResult, error)
	GetJob(context.Context, string) (domain.Job, error)
	ListJobs(context.Context, domain.ListJobsFilter) ([]domain.Job, error)
	GetOverview(context.Context) (domain.JobOverview, error)
	MarkJobQueued(context.Context, domain.Job) error
	MarkJobActive(context.Context, domain.Job) error
	MarkJobCompleted(context.Context, domain.Job) error
	MarkJobRetrying(context.Context, domain.Job, time.Time) error
	MarkJobFailed(context.Context, domain.Job) error
	MarkJobCanceled(context.Context, domain.Job) error
	MarkJobThrottled(context.Context, domain.Job) error
	UpdateJobHeartbeat(context.Context, string, string, time.Time, time.Time) error
	RecordJobEvent(context.Context, domain.JobEvent) error
	ListJobEvents(context.Context, string, int) ([]domain.JobEvent, error)
	UpsertJobAttempt(context.Context, domain.JobAttempt) error
	ListJobAttempts(context.Context, string) ([]domain.JobAttempt, error)
	UpsertDeadLetter(context.Context, domain.DeadLetter) error
	GetDeadLetter(context.Context, string) (domain.DeadLetter, error)
	ListDeadLetters(context.Context, domain.DeadLetterFilter) ([]domain.DeadLetter, error)
	DeleteDeadLetters(context.Context, []string) error
	RecordDeadLetterAction(context.Context, domain.DeadLetterAction) error
	GetIdempotencyRecord(context.Context, string) (domain.IdempotencyRecord, error)
	UpdateIdempotencyOutcome(context.Context, domain.Job, string) error
	ListDependencies(context.Context, string) ([]domain.JobDependency, error)
	ListDependentJobs(context.Context, string) ([]domain.Job, error)
	GetDependencyGraph(context.Context, string) (domain.DependencyGraph, error)
	ListBlockedJobs(context.Context, int) ([]domain.Job, error)
	ListThrottledJobs(context.Context, int) ([]domain.Job, error)
	UpsertWorker(context.Context, domain.WorkerStatus) error
	ListWorkers(context.Context) ([]domain.WorkerStatus, error)
	GetWorkerLeaseHealth(context.Context) ([]domain.WorkerLeaseHealth, error)
	UpsertSchedule(context.Context, domain.Schedule) error
	ListSchedules(context.Context) ([]domain.Schedule, error)
	ListDueSchedules(context.Context, time.Time) ([]domain.Schedule, error)
	UpdateScheduleRun(context.Context, string, time.Time, time.Time) error
	ListRateLimitPolicies(context.Context) ([]domain.RateLimitPolicy, error)
	UpsertRateLimitPolicy(context.Context, domain.RateLimitPolicy) (domain.RateLimitPolicy, error)
	GetMetricsSummary(context.Context, time.Duration) (domain.MetricsSummary, error)
	GetMetricsTrend(context.Context, time.Duration, time.Duration) (domain.MetricsTrend, error)
}

type Broker = queue.Broker
