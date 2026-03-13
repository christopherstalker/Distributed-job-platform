package service

import (
	"context"
	"fmt"
	"time"

	"distributed-job-system/libs/backend/domain"

	"github.com/google/uuid"
)

func (m *Manager) GetJobEvents(ctx context.Context, jobID string, limit int) ([]domain.JobEvent, error) {
	return m.Repo.ListJobEvents(ctx, jobID, limit)
}

func (m *Manager) GetJobInspection(ctx context.Context, jobID string) (domain.JobInspection, error) {
	job, err := m.Repo.GetJob(ctx, jobID)
	if err != nil {
		return domain.JobInspection{}, err
	}

	inspection := domain.JobInspection{Job: job}

	if attempts, attemptErr := m.Repo.ListJobAttempts(ctx, jobID); attemptErr == nil {
		inspection.Attempts = attempts
	}
	if events, eventErr := m.Repo.ListJobEvents(ctx, jobID, 80); eventErr == nil {
		inspection.Events = events
	}
	if graph, graphErr := m.Repo.GetDependencyGraph(ctx, jobID); graphErr == nil {
		inspection.Graph = graph
	}
	if deadLetter, deadErr := m.Repo.GetDeadLetter(ctx, jobID); deadErr == nil {
		inspection.DeadLetter = &deadLetter
	}
	if job.IdempotencyKey != "" {
		scope := domain.IdempotencyScope(job.TenantID, job.Type, job.IdempotencyKey)
		if record, recordErr := m.Repo.GetIdempotencyRecord(ctx, scope); recordErr == nil {
			inspection.Idempotency = &record
		}
	}

	return normalizeJobInspection(inspection), nil
}

func (m *Manager) GetDependencyGraph(ctx context.Context, rootJobID string) (domain.DependencyGraph, error) {
	graph, err := m.Repo.GetDependencyGraph(ctx, rootJobID)
	if err != nil {
		return domain.DependencyGraph{}, err
	}
	return normalizeDependencyGraph(graph), nil
}

func (m *Manager) ListDeadLetters(ctx context.Context, filter domain.DeadLetterFilter) ([]domain.DeadLetter, error) {
	deadLetters, err := m.Repo.ListDeadLetters(ctx, filter)
	if err != nil {
		return nil, err
	}
	return ensureSlice(deadLetters), nil
}

func (m *Manager) ReplayDeadLetters(ctx context.Context, req domain.DeadLetterReplayRequest) ([]domain.Job, error) {
	replayed := make([]domain.Job, 0, len(req.JobIDs))
	now := time.Now().UTC()
	actor := req.Actor
	if actor == "" {
		actor = "operator"
	}

	for _, jobID := range req.JobIDs {
		job, err := m.Repo.GetJob(ctx, jobID)
		if err != nil {
			return nil, err
		}
		previousQueue := job.Queue
		previousPayload := job.Payload
		if req.Queue != "" {
			job.Queue = req.Queue
		}
		if len(req.Payload) > 0 {
			job.Payload = req.Payload
		}
		if req.JobType != "" {
			job.Type = req.JobType
		}
		if req.Priority != nil {
			job.Priority = *req.Priority
		}
		job.State = domain.JobStateQueued
		job.Attempts = 0
		job.LastError = ""
		job.Result = nil
		job.UpdatedAt = now
		job.RunAt = now
		job.StartedAt = nil
		job.FinishedAt = nil
		job.LastHeartbeatAt = nil
		job.LeaseExpiresAt = nil
		job.ThrottleUntil = nil
		job.BlockedReason = ""
		if err := m.Broker.Retry(ctx, job, now); err != nil {
			return nil, err
		}
		if err := m.Repo.MarkJobQueued(ctx, job); err != nil {
			return nil, err
		}
		if err := m.Repo.DeleteDeadLetters(ctx, []string{job.ID}); err != nil {
			return nil, err
		}
		_ = m.Repo.RecordDeadLetterAction(ctx, domain.DeadLetterAction{
			JobID:         job.ID,
			Action:        "replay",
			Actor:         actor,
			FromQueue:     previousQueue,
			ToQueue:       job.Queue,
			PayloadBefore: previousPayload,
			PayloadAfter:  job.Payload,
			OccurredAt:    now,
		})
		_ = m.Repo.RecordJobEvent(ctx, domain.JobEvent{
			JobID:      job.ID,
			Type:       "job.replayed",
			Message:    fmt.Sprintf("dead letter replayed into %s", job.Queue),
			OccurredAt: now,
		})
		replayed = append(replayed, job)
	}

	m.publish(ctx, domain.SystemEvent{
		Kind:      "job.replayed",
		Message:   fmt.Sprintf("%d dead-letter jobs replayed", len(replayed)),
		Timestamp: now,
	})
	return replayed, nil
}

func (m *Manager) DeleteDeadLetters(ctx context.Context, req domain.DeadLetterDeleteRequest) error {
	if len(req.JobIDs) == 0 {
		return nil
	}
	if err := m.Repo.DeleteDeadLetters(ctx, req.JobIDs); err != nil {
		return err
	}
	now := time.Now().UTC()
	actor := req.Actor
	if actor == "" {
		actor = "operator"
	}
	for _, jobID := range req.JobIDs {
		_ = m.Repo.RecordDeadLetterAction(ctx, domain.DeadLetterAction{
			JobID:      jobID,
			Action:     "delete",
			Actor:      actor,
			OccurredAt: now,
		})
	}
	m.publish(ctx, domain.SystemEvent{
		Kind:      "job.dead_letter_deleted",
		Message:   fmt.Sprintf("%d dead-letter jobs deleted", len(req.JobIDs)),
		Timestamp: now,
	})
	return nil
}

func (m *Manager) ListRateLimitPolicies(ctx context.Context) ([]domain.RateLimitPolicy, error) {
	return m.Repo.ListRateLimitPolicies(ctx)
}

func (m *Manager) UpsertRateLimitPolicy(ctx context.Context, policy domain.RateLimitPolicy) (domain.RateLimitPolicy, error) {
	if err := policy.Validate(); err != nil {
		return domain.RateLimitPolicy{}, err
	}
	saved, err := m.Repo.UpsertRateLimitPolicy(ctx, policy)
	if err != nil {
		return domain.RateLimitPolicy{}, err
	}
	m.publish(ctx, domain.SystemEvent{
		Kind:      "rate_limit.updated",
		Message:   saved.Name,
		Timestamp: time.Now().UTC(),
	})
	return saved, nil
}

func (m *Manager) GetDashboardSnapshot(ctx context.Context) (domain.DashboardSnapshot, error) {
	overview, err := m.GetOverview(ctx)
	if err != nil {
		return domain.DashboardSnapshot{}, err
	}
	metricsSummary, err := m.Repo.GetMetricsSummary(ctx, time.Hour)
	if err != nil {
		return domain.DashboardSnapshot{}, err
	}
	trend, err := m.Repo.GetMetricsTrend(ctx, 5*time.Minute, time.Hour)
	if err != nil {
		return domain.DashboardSnapshot{}, err
	}
	workers, err := m.Repo.GetWorkerLeaseHealth(ctx)
	if err != nil {
		return domain.DashboardSnapshot{}, err
	}
	deadLetters, err := m.Repo.ListDeadLetters(ctx, domain.DeadLetterFilter{Limit: 25})
	if err != nil {
		return domain.DashboardSnapshot{}, err
	}
	blockedJobs, err := m.Repo.ListBlockedJobs(ctx, 25)
	if err != nil {
		return domain.DashboardSnapshot{}, err
	}
	throttledJobs, err := m.Repo.ListThrottledJobs(ctx, 25)
	if err != nil {
		return domain.DashboardSnapshot{}, err
	}
	policies, err := m.Repo.ListRateLimitPolicies(ctx)
	if err != nil {
		return domain.DashboardSnapshot{}, err
	}

	var leader domain.SchedulerLeaderStatus
	if m.Leader != nil {
		leader, _ = m.Leader.Status(ctx)
	}
	var rateLimits []domain.RateLimitStatus
	if m.RateLimiter != nil {
		rateLimits, _ = m.RateLimiter.Status(ctx, policies)
	}

	return normalizeDashboardSnapshot(domain.DashboardSnapshot{
		Overview:      overview,
		Metrics:       metricsSummary,
		Trend:         trend,
		Workers:       workers,
		DeadLetters:   deadLetters,
		BlockedJobs:   blockedJobs,
		ThrottledJobs: throttledJobs,
		RateLimits:    rateLimits,
		Leader:        leader,
	}), nil
}

func (m *Manager) CreateDemoThumbnailWorkflow(ctx context.Context, tenantID string) (domain.DependencyGraph, error) {
	workflowID := uuid.NewString()
	ingest, err := m.EnqueueJob(ctx, domain.JobRequest{
		Type:          "file.ingest",
		Queue:         "default",
		TenantID:      tenantOrDefault(tenantID),
		SchemaVersion: 1,
		WorkflowID:    workflowID,
		Payload: JSON(map[string]any{
			"fileId":     workflowID,
			"source":     "s3://demo/incoming/image.png",
			"durationMs": 300,
		}),
	})
	if err != nil {
		return domain.DependencyGraph{}, err
	}

	thumbnailJobs := make([]domain.EnqueueResult, 0, 3)
	for _, size := range []string{"sm", "md", "lg"} {
		job, err := m.EnqueueJob(ctx, domain.JobRequest{
			Type:             "image.thumbnail",
			Queue:            "default",
			TenantID:         tenantOrDefault(tenantID),
			SchemaVersion:    1,
			WorkflowID:       workflowID,
			ParentJobID:      ingest.Job.ID,
			Dependencies:     []string{ingest.Job.ID},
			DependencyPolicy: domain.DependencyFailurePolicyBlock,
			Payload: JSON(map[string]any{
				"fileId":     workflowID,
				"size":       size,
				"durationMs": 250,
			}),
		})
		if err != nil {
			return domain.DependencyGraph{}, err
		}
		thumbnailJobs = append(thumbnailJobs, job)
	}

	dependencyIDs := make([]string, 0, len(thumbnailJobs))
	for _, job := range thumbnailJobs {
		dependencyIDs = append(dependencyIDs, job.Job.ID)
	}

	aggregate, err := m.EnqueueJob(ctx, domain.JobRequest{
		Type:             "metadata.aggregate",
		Queue:            "default",
		TenantID:         tenantOrDefault(tenantID),
		SchemaVersion:    1,
		WorkflowID:       workflowID,
		ParentJobID:      ingest.Job.ID,
		Dependencies:     dependencyIDs,
		DependencyPolicy: domain.DependencyFailurePolicyBlock,
		Payload: JSON(map[string]any{
			"fileId":     workflowID,
			"durationMs": 350,
		}),
	})
	if err != nil {
		return domain.DependencyGraph{}, err
	}

	if _, err := m.EnqueueJob(ctx, domain.JobRequest{
		Type:             "user.notify",
		Queue:            "critical",
		TenantID:         tenantOrDefault(tenantID),
		SchemaVersion:    1,
		WorkflowID:       workflowID,
		ParentJobID:      aggregate.Job.ID,
		Dependencies:     []string{aggregate.Job.ID},
		DependencyPolicy: domain.DependencyFailurePolicyBlock,
		Payload: JSON(map[string]any{
			"userId":     "demo-user",
			"channel":    "email",
			"durationMs": 125,
		}),
	}); err != nil {
		return domain.DependencyGraph{}, err
	}

	return m.Repo.GetDependencyGraph(ctx, ingest.Job.ID)
}

func normalizeDashboardSnapshot(snapshot domain.DashboardSnapshot) domain.DashboardSnapshot {
	snapshot.Trend.Throughput = ensureSlice(snapshot.Trend.Throughput)
	snapshot.Trend.ExecutionP95Ms = ensureSlice(snapshot.Trend.ExecutionP95Ms)
	snapshot.Trend.QueueLatencyP95Ms = ensureSlice(snapshot.Trend.QueueLatencyP95Ms)
	snapshot.Trend.RetryRate = ensureSlice(snapshot.Trend.RetryRate)
	snapshot.Trend.DeadLetterRate = ensureSlice(snapshot.Trend.DeadLetterRate)
	snapshot.Workers = ensureSlice(snapshot.Workers)
	snapshot.DeadLetters = ensureSlice(snapshot.DeadLetters)
	snapshot.BlockedJobs = ensureSlice(snapshot.BlockedJobs)
	snapshot.ThrottledJobs = ensureSlice(snapshot.ThrottledJobs)
	snapshot.RateLimits = ensureSlice(snapshot.RateLimits)
	return snapshot
}

func normalizeJobInspection(inspection domain.JobInspection) domain.JobInspection {
	inspection.Attempts = ensureSlice(inspection.Attempts)
	inspection.Events = ensureSlice(inspection.Events)
	inspection.Graph = normalizeDependencyGraph(inspection.Graph)
	if inspection.DeadLetter != nil {
		inspection.DeadLetter.Attempts = ensureSlice(inspection.DeadLetter.Attempts)
	}
	return inspection
}

func normalizeDependencyGraph(graph domain.DependencyGraph) domain.DependencyGraph {
	graph.Nodes = ensureSlice(graph.Nodes)
	return graph
}

func ensureSlice[T any](items []T) []T {
	if items == nil {
		return []T{}
	}
	return items
}
