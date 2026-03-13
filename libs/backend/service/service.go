package service

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"distributed-job-system/libs/backend/domain"
	"distributed-job-system/libs/backend/metrics"

	"github.com/google/uuid"
	"github.com/robfig/cron/v3"
)

type Publisher interface {
	Publish(context.Context, domain.SystemEvent) error
}

type SchemaValidator interface {
	Validate(string, int, json.RawMessage) error
}

type LeaderStatusReader interface {
	Status(context.Context) (domain.SchedulerLeaderStatus, error)
}

type RateLimitStatusReader interface {
	Status(context.Context, []domain.RateLimitPolicy) ([]domain.RateLimitStatus, error)
}

type Manager struct {
	Repo                Repository
	Broker              Broker
	Bus                 Publisher
	Metrics             *metrics.Metrics
	Log                 *slog.Logger
	Schemas             SchemaValidator
	Leader              LeaderStatusReader
	RateLimiter         RateLimitStatusReader
	DefaultDedupeWindow time.Duration
}

func NewManager(repo Repository, broker Broker, bus Publisher, metricSet *metrics.Metrics, log *slog.Logger) *Manager {
	return &Manager{
		Repo:    repo,
		Broker:  broker,
		Bus:     bus,
		Metrics: metricSet,
		Log:     log,
	}
}

func (m *Manager) EnqueueJob(ctx context.Context, req domain.JobRequest) (domain.EnqueueResult, error) {
	if err := req.Validate(); err != nil {
		return domain.EnqueueResult{}, err
	}
	schemaVersion := req.SchemaVersion
	if schemaVersion <= 0 {
		schemaVersion = 1
	}
	if m.Schemas != nil {
		if err := m.Schemas.Validate(req.Type, schemaVersion, req.Payload); err != nil {
			return domain.EnqueueResult{}, err
		}
	}
	now := time.Now().UTC()
	job := buildJob(now, req)
	dependencies := sanitizeDependencies(req.Dependencies, job.ID)

	var (
		result domain.EnqueueResult
		err    error
	)
	if job.IdempotencyKey != "" {
		window := m.DefaultDedupeWindow
		if window <= 0 {
			window = 15 * time.Minute
		}
		if req.DedupeWindowSeconds > 0 {
			window = time.Duration(req.DedupeWindowSeconds) * time.Second
		}
		result, err = m.Repo.CreateJobWithIdempotency(ctx, job, dependencies, window)
	} else {
		err = m.Repo.CreateJobBundle(ctx, job, dependencies)
		result = domain.EnqueueResult{Job: job}
	}
	if err != nil {
		return domain.EnqueueResult{}, err
	}
	if result.DuplicateSuppressed {
		if m.Metrics != nil {
			m.Metrics.DuplicateSuppressedTotal.Inc()
		}
		_ = m.Repo.RecordJobEvent(ctx, domain.JobEvent{
			JobID:      result.Job.ID,
			Type:       "job.duplicate_suppressed",
			Message:    fmt.Sprintf("duplicate submission suppressed for idempotency key %s", result.Job.IdempotencyKey),
			OccurredAt: now,
		})
		m.publish(ctx, domain.SystemEvent{
			Kind:      "job.duplicate_suppressed",
			JobID:     result.Job.ID,
			Queue:     result.Job.Queue,
			State:     result.Job.State,
			Timestamp: now,
		})
		return result, nil
	}
	if err := m.Broker.Enqueue(ctx, result.Job); err != nil {
		return domain.EnqueueResult{}, err
	}
	if m.Metrics != nil {
		m.Metrics.EnqueuedTotal.Inc()
	}
	eventType := "job.enqueued"
	message := fmt.Sprintf("job queued into %s", result.Job.Queue)
	if result.Job.State == domain.JobStateBlocked {
		eventType = "job.blocked"
		message = fmt.Sprintf("job blocked on %d dependencies", len(dependencies))
	}
	_ = m.Repo.RecordJobEvent(ctx, domain.JobEvent{
		JobID:      result.Job.ID,
		Type:       eventType,
		Message:    message,
		OccurredAt: now,
	})
	m.publish(ctx, domain.SystemEvent{
		Kind:      eventType,
		JobID:     result.Job.ID,
		Queue:     result.Job.Queue,
		State:     result.Job.State,
		Timestamp: now,
	})
	return result, nil
}

func (m *Manager) EnqueueBatch(ctx context.Context, requests []domain.JobRequest) ([]domain.EnqueueResult, error) {
	results := make([]domain.EnqueueResult, 0, len(requests))
	for _, req := range requests {
		result, err := m.EnqueueJob(ctx, req)
		if err != nil {
			return nil, err
		}
		results = append(results, result)
	}
	m.publish(ctx, domain.SystemEvent{
		Kind:      "job.batch_enqueued",
		Message:   fmt.Sprintf("%d jobs submitted", len(results)),
		Timestamp: time.Now().UTC(),
	})
	return results, nil
}

func (m *Manager) GetJob(ctx context.Context, jobID string) (domain.Job, error) {
	return m.Repo.GetJob(ctx, jobID)
}

func (m *Manager) ListJobs(ctx context.Context, filter domain.ListJobsFilter) ([]domain.Job, error) {
	return m.Repo.ListJobs(ctx, filter)
}

func (m *Manager) GetOverview(ctx context.Context) (domain.JobOverview, error) {
	overview, err := m.Repo.GetOverview(ctx)
	if err != nil {
		return domain.JobOverview{}, err
	}
	overview.QueueLengths = defaultQueueLengths()
	queueLengths, delayedCount, activeLeases, err := m.Broker.QueueLengths(ctx, domain.SupportedQueues)
	if err == nil {
		for queueName, length := range queueLengths {
			overview.QueueLengths[queueName] = length
		}
		overview.DelayedBacklog = delayedCount
		overview.ActiveJobs = activeLeases
	} else if m.Log != nil {
		m.Log.Warn("failed to fetch live queue lengths", "error", err)
	}
	overview.LastUpdatedAt = time.Now().UTC()
	return overview, nil
}

func (m *Manager) RetryJob(ctx context.Context, jobID string) (domain.Job, error) {
	job, err := m.Repo.GetJob(ctx, jobID)
	if err != nil {
		return domain.Job{}, err
	}
	now := time.Now().UTC()
	job.State = domain.JobStateQueued
	job.Attempts = 0
	job.LastError = ""
	job.Result = nil
	job.RunAt = now
	job.UpdatedAt = now
	job.StartedAt = nil
	job.FinishedAt = nil
	job.ThrottleUntil = nil
	job.LeaseExpiresAt = nil
	job.BlockedReason = ""
	job.CancelRequested = false
	if err := m.Broker.Retry(ctx, job, now); err != nil {
		return domain.Job{}, err
	}
	if err := m.Repo.MarkJobQueued(ctx, job); err != nil {
		return domain.Job{}, err
	}
	_ = m.Repo.DeleteDeadLetters(ctx, []string{jobID})
	_ = m.Repo.RecordDeadLetterAction(ctx, domain.DeadLetterAction{
		JobID:      jobID,
		Action:     "replay",
		Actor:      "operator",
		FromQueue:  job.Queue,
		ToQueue:    job.Queue,
		OccurredAt: now,
	})
	_ = m.Repo.RecordJobEvent(ctx, domain.JobEvent{
		JobID:      job.ID,
		Type:       "job.retried",
		Message:    "job manually retried",
		OccurredAt: now,
	})
	m.publish(ctx, domain.SystemEvent{
		Kind:      "job.retried",
		JobID:     job.ID,
		Queue:     job.Queue,
		State:     job.State,
		Timestamp: now,
	})
	return job, nil
}

func (m *Manager) CancelJob(ctx context.Context, jobID string) (domain.Job, error) {
	job, err := m.Repo.GetJob(ctx, jobID)
	if err != nil {
		return domain.Job{}, err
	}
	if _, err := m.Broker.Cancel(ctx, jobID); err != nil {
		return domain.Job{}, err
	}
	now := time.Now().UTC()
	job.CancelRequested = true
	job.UpdatedAt = now
	job.LastError = "canceled by operator"
	if job.State == domain.JobStateQueued || job.State == domain.JobStateRetrying || job.State == domain.JobStateScheduled || job.State == domain.JobStateFailed {
		job.State = domain.JobStateCanceled
		job.FinishedAt = &now
	}
	if err := m.Repo.MarkJobCanceled(ctx, job); err != nil {
		return domain.Job{}, err
	}
	_ = m.Repo.RecordJobEvent(ctx, domain.JobEvent{
		JobID:      job.ID,
		Type:       "job.canceled",
		Message:    "job cancellation requested",
		OccurredAt: now,
	})
	m.publish(ctx, domain.SystemEvent{
		Kind:      "job.canceled",
		JobID:     job.ID,
		Queue:     job.Queue,
		State:     job.State,
		Timestamp: now,
	})
	return job, nil
}

func (m *Manager) ListWorkers(ctx context.Context) ([]domain.WorkerStatus, error) {
	return m.Repo.ListWorkers(ctx)
}

func (m *Manager) ListSchedules(ctx context.Context) ([]domain.Schedule, error) {
	return m.Repo.ListSchedules(ctx)
}

func (m *Manager) UpsertSchedule(ctx context.Context, req domain.ScheduleRequest) (domain.Schedule, error) {
	if req.Name == "" || req.Type == "" || req.CronExpression == "" {
		return domain.Schedule{}, fmt.Errorf("name, type, and cronExpression are required")
	}
	if req.Queue == "" {
		req.Queue = "default"
	}
	if req.MaxAttempts <= 0 {
		req.MaxAttempts = 5
	}
	location := time.UTC
	if req.Timezone != "" {
		loaded, err := time.LoadLocation(req.Timezone)
		if err != nil {
			return domain.Schedule{}, err
		}
		location = loaded
	}
	spec, err := cron.ParseStandard(req.CronExpression)
	if err != nil {
		return domain.Schedule{}, err
	}
	now := time.Now().UTC()
	nextRun := spec.Next(now.In(location)).UTC()
	schedule := domain.Schedule{
		ID:             uuid.NewSHA1(uuid.NameSpaceURL, []byte(req.Name)).String(),
		Name:           req.Name,
		CronExpression: req.CronExpression,
		Queue:          req.Queue,
		Type:           req.Type,
		Payload:        req.Payload,
		Priority:       5,
		MaxAttempts:    req.MaxAttempts,
		TimeoutSeconds: req.TimeoutSeconds,
		Enabled:        true,
		Timezone:       req.Timezone,
		NextRunAt:      nextRun,
		CreatedAt:      now,
		UpdatedAt:      now,
	}
	if req.Priority != nil {
		schedule.Priority = *req.Priority
	}
	if req.Enabled != nil {
		schedule.Enabled = *req.Enabled
	}
	if req.Timezone == "" {
		schedule.Timezone = "UTC"
	}
	if err := m.Repo.UpsertSchedule(ctx, schedule); err != nil {
		return domain.Schedule{}, err
	}
	m.publish(ctx, domain.SystemEvent{
		Kind:      "schedule.updated",
		Message:   schedule.Name,
		Timestamp: now,
	})
	return schedule, nil
}

func buildJob(now time.Time, req domain.JobRequest) domain.Job {
	runAt := now
	if req.DelaySeconds > 0 {
		runAt = now.Add(time.Duration(req.DelaySeconds) * time.Second)
	}
	if req.ScheduledAt != nil && req.ScheduledAt.After(runAt) {
		runAt = req.ScheduledAt.UTC()
	}
	maxAttempts := req.MaxAttempts
	if maxAttempts <= 0 {
		maxAttempts = 5
	}
	priority := 5
	if req.Priority != nil {
		priority = *req.Priority
	}
	state := domain.JobStateQueued
	blockedReason := ""
	if len(req.Dependencies) > 0 {
		state = domain.JobStateBlocked
		blockedReason = fmt.Sprintf("waiting on %d dependencies", len(req.Dependencies))
	}
	if runAt.After(now) && state != domain.JobStateBlocked {
		state = domain.JobStateScheduled
	}
	schemaVersion := req.SchemaVersion
	if schemaVersion <= 0 {
		schemaVersion = 1
	}
	return domain.Job{
		ID:               uuid.NewString(),
		Type:             req.Type,
		Queue:            domain.NormalizeQueue(req.Queue),
		TenantID:         tenantOrDefault(req.TenantID),
		Payload:          req.Payload,
		Priority:         priority,
		MaxAttempts:      maxAttempts,
		State:            state,
		SchemaVersion:    schemaVersion,
		IdempotencyKey:   req.IdempotencyKey,
		WorkflowID:       req.WorkflowID,
		ParentJobID:      req.ParentJobID,
		DependencyPolicy: req.DependencyPolicy.Normalize(),
		BlockedReason:    blockedReason,
		CreatedAt:        now,
		UpdatedAt:        now,
		RunAt:            runAt,
		TimeoutSeconds:   req.TimeoutSeconds,
	}
}

func (m *Manager) publish(ctx context.Context, event domain.SystemEvent) {
	if event.Timestamp.IsZero() {
		event.Timestamp = time.Now().UTC()
	}
	if m.Bus == nil {
		return
	}
	if err := m.Bus.Publish(ctx, event); err != nil && m.Log != nil {
		m.Log.Warn("failed to publish event", "kind", event.Kind, "error", err)
	}
}

func JSON(v any) json.RawMessage {
	payload, _ := json.Marshal(v)
	return payload
}

func defaultQueueLengths() map[string]int64 {
	queueLengths := make(map[string]int64, len(domain.SupportedQueues))
	for _, queueName := range domain.SupportedQueues {
		queueLengths[queueName] = 0
	}
	return queueLengths
}

func tenantOrDefault(value string) string {
	if value == "" {
		return "default"
	}
	return value
}

func sanitizeDependencies(ids []string, selfID string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		if id == "" || id == selfID {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}
	return out
}
