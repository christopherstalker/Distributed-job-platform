package worker

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"runtime/debug"
	"strings"
	"sync"
	"time"

	"distributed-job-system/libs/backend/domain"
	"distributed-job-system/libs/backend/limits"
	"distributed-job-system/libs/backend/metrics"
	"distributed-job-system/libs/backend/processors"
	"distributed-job-system/libs/backend/service"
)

type Runtime struct {
	Repo                  service.Repository
	Broker                service.Broker
	Bus                   service.Publisher
	Registry              *processors.Registry
	Metrics               *metrics.Metrics
	Log                   *slog.Logger
	WorkerStatus          domain.WorkerStatus
	LeaseTTL              time.Duration
	HeartbeatInterval     time.Duration
	QueuePollInterval     time.Duration
	BaseRetryDelay        time.Duration
	MaxRetryDelay         time.Duration
	PolicyRefreshInterval time.Duration
	Limiter               interface {
		EvaluateAndAcquire(context.Context, domain.Job, []domain.RateLimitPolicy, time.Duration) (limits.Decision, error)
		Renew(context.Context, domain.Job, []domain.RateLimitPolicy, time.Duration) error
		Release(context.Context, domain.Job, []domain.RateLimitPolicy) error
	}
	mu       sync.RWMutex
	policies []domain.RateLimitPolicy
}

func (r *Runtime) Run(ctx context.Context) error {
	if err := r.updateWorker(ctx, "starting"); err != nil {
		return err
	}

	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	var wg sync.WaitGroup
	sem := make(chan struct{}, r.WorkerStatus.Concurrency)

	go r.workerHeartbeat(runCtx)
	go r.policyRefreshLoop(runCtx)
	if err := r.updateWorker(ctx, "running"); err != nil {
		return err
	}

	for {
		select {
		case <-runCtx.Done():
			_ = r.updateWorker(context.Background(), "draining")
			waitFor(&wg, 2*r.LeaseTTL)
			_ = r.updateWorker(context.Background(), "stopped")
			return nil
		case sem <- struct{}{}:
			leasedJob, err := r.Broker.Dequeue(runCtx, r.WorkerStatus.WorkerID, r.WorkerStatus.Queues, r.LeaseTTL)
			if err != nil {
				<-sem
				r.Log.Error("dequeue failed", "error", err)
				sleepOrDone(runCtx, r.QueuePollInterval)
				continue
			}
			if leasedJob == nil {
				<-sem
				sleepOrDone(runCtx, r.QueuePollInterval)
				continue
			}
			wg.Add(1)
			go func(job *domain.LeasedJob) {
				defer func() {
					<-sem
					wg.Done()
				}()
				r.process(runCtx, *job)
			}(leasedJob)
		}
	}
}

func (r *Runtime) process(parent context.Context, leased domain.LeasedJob) {
	started := time.Now().UTC()
	leased.Job.WorkerID = r.WorkerStatus.WorkerID
	leased.Job.State = domain.JobStateActive
	leased.Job.LeaseToken = leased.LeaseToken
	leased.Job.UpdatedAt = started
	leased.Job.StartedAt = &started
	leased.Job.LastHeartbeatAt = &started
	expiresAt := started.Add(r.LeaseTTL)
	leased.Job.LeaseExpiresAt = &expiresAt

	policies := r.currentPolicies()
	if r.Limiter != nil && len(policies) > 0 {
		decision, err := r.Limiter.EvaluateAndAcquire(parent, leased.Job, policies, r.LeaseTTL)
		if err != nil {
			r.Log.Error("failed to evaluate rate limits", "job_id", leased.ID, "error", err)
			r.throttle(parent, leased.Job, leased.LeaseToken, started.Add(r.HeartbeatInterval), "rate limiter unavailable")
			return
		}
		if !decision.Allowed {
			r.throttle(parent, leased.Job, leased.LeaseToken, decision.RetryAt, throttleReason(decision.Reasons))
			return
		}
		defer func() {
			if err := r.Limiter.Release(context.Background(), leased.Job, policies); err != nil {
				r.Log.Warn("failed to release limiter slot", "job_id", leased.ID, "error", err)
			}
		}()
	}

	if err := r.Repo.MarkJobActive(parent, leased.Job); err != nil {
		r.Log.Error("failed to persist active job", "job_id", leased.ID, "error", err)
	}
	_ = r.Repo.UpsertJobAttempt(parent, domain.JobAttempt{
		JobID:      leased.ID,
		Attempt:    leased.Job.Attempts,
		WorkerID:   r.WorkerStatus.WorkerID,
		LeaseToken: leased.LeaseToken,
		Status:     "started",
		StartedAt:  started,
	})
	_ = r.Repo.RecordJobEvent(parent, domain.JobEvent{
		JobID:      leased.ID,
		Type:       "job.started",
		Message:    fmt.Sprintf("worker %s started processing", r.WorkerStatus.WorkerID),
		OccurredAt: started,
	})
	r.publish(parent, domain.SystemEvent{
		Kind:      "job.started",
		JobID:     leased.ID,
		Queue:     leased.Queue,
		WorkerID:  r.WorkerStatus.WorkerID,
		State:     domain.JobStateActive,
		Timestamp: started,
	})

	if r.Metrics != nil {
		r.Metrics.StartedTotal.Inc()
		r.Metrics.ActiveJobs.Inc()
		queueLatency := started.Sub(leased.Job.RunAt)
		if queueLatency > 0 {
			r.Metrics.QueueLatencyHistogram.Observe(queueLatency.Seconds())
		}
		defer r.Metrics.ActiveJobs.Dec()
	}

	handler, err := r.Registry.Resolve(leased.Type)
	if err != nil {
		r.handleFailure(parent, leased.Job, leased.LeaseToken, err, started)
		return
	}

	jobCtx := parent
	var cancel context.CancelFunc
	if leased.TimeoutSeconds > 0 {
		jobCtx, cancel = context.WithTimeout(parent, time.Duration(leased.TimeoutSeconds)*time.Second)
	} else {
		jobCtx, cancel = context.WithCancel(parent)
	}
	defer cancel()

	done := make(chan struct{})
	go r.heartbeatLoop(jobCtx, leased.Job, leased.LeaseToken, policies, done)

	result, err := handler.Handle(jobCtx, leased.Job)
	close(done)

	finished := time.Now().UTC()
	leased.Job.ExecutionMs = finished.Sub(started).Milliseconds()
	leased.Job.UpdatedAt = finished

	if err != nil {
		r.handleFailure(parent, leased.Job, leased.LeaseToken, err, finished)
		return
	}

	leased.Job.State = domain.JobStateCompleted
	leased.Job.Result = result
	leased.Job.FinishedAt = &finished
	ok, ackErr := r.Broker.Complete(parent, leased.Job, leased.LeaseToken, result, finished)
	if ackErr != nil {
		r.Log.Error("failed to ack job", "job_id", leased.ID, "error", ackErr)
		return
	}
	if !ok {
		r.Log.Warn("lease lost before completion", "job_id", leased.ID)
		return
	}
	if err := r.Repo.MarkJobCompleted(parent, leased.Job); err != nil {
		r.Log.Error("failed to persist completed job", "job_id", leased.ID, "error", err)
	}
	_ = r.Repo.UpdateIdempotencyOutcome(parent, leased.Job, "completed")
	_ = r.Repo.UpsertJobAttempt(parent, domain.JobAttempt{
		JobID:      leased.Job.ID,
		Attempt:    leased.Job.Attempts,
		WorkerID:   r.WorkerStatus.WorkerID,
		LeaseToken: leased.LeaseToken,
		Status:     "completed",
		StartedAt:  started,
		FinishedAt: &finished,
	})
	_ = r.Repo.RecordJobEvent(parent, domain.JobEvent{
		JobID:      leased.ID,
		Type:       "job.completed",
		Message:    "job completed successfully",
		OccurredAt: finished,
	})
	if r.Metrics != nil {
		r.Metrics.CompletedTotal.Inc()
		r.Metrics.ExecutionHistogram.Observe(finished.Sub(started).Seconds())
	}
	r.publish(parent, domain.SystemEvent{
		Kind:      "job.completed",
		JobID:     leased.ID,
		Queue:     leased.Queue,
		WorkerID:  r.WorkerStatus.WorkerID,
		State:     domain.JobStateCompleted,
		Timestamp: finished,
	})
	r.resolveDependents(parent, leased.Job, true, finished)
}

func (r *Runtime) handleFailure(ctx context.Context, job domain.Job, leaseToken string, processingErr error, finished time.Time) {
	job.ExecutionMs = finished.Sub(*job.StartedAt).Milliseconds()
	job.UpdatedAt = finished
	job.LastError = processingErr.Error()
	if errors.Is(processingErr, context.DeadlineExceeded) {
		job.LastError = "job timed out"
	}

	var retryAt *time.Time
	if job.Attempts < job.MaxAttempts {
		next := finished.Add(domain.ComputeBackoff(job.Attempts, r.BaseRetryDelay, r.MaxRetryDelay))
		retryAt = &next
		job.State = domain.JobStateRetrying
	} else {
		job.State = domain.JobStateFailed
		job.FinishedAt = &finished
	}

	ok, err := r.Broker.Fail(ctx, job, leaseToken, job.LastError, retryAt, finished)
	if err != nil {
		r.Log.Error("failed to persist failed job in broker", "job_id", job.ID, "error", err)
		return
	}
	if !ok {
		r.Log.Warn("lease lost before failure handling", "job_id", job.ID)
		return
	}

	if retryAt != nil {
		if err := r.Repo.MarkJobRetrying(ctx, job, *retryAt); err != nil {
			r.Log.Error("failed to persist retrying job", "job_id", job.ID, "error", err)
		}
		_ = r.Repo.UpsertJobAttempt(ctx, domain.JobAttempt{
			JobID:        job.ID,
			Attempt:      job.Attempts,
			WorkerID:     r.WorkerStatus.WorkerID,
			LeaseToken:   leaseToken,
			Status:       "retrying",
			ErrorType:    fmt.Sprintf("%T", processingErr),
			ErrorMessage: job.LastError,
			StackTrace:   string(debug.Stack()),
			StartedAt:    *job.StartedAt,
			FinishedAt:   &finished,
		})
		_ = r.Repo.RecordJobEvent(ctx, domain.JobEvent{
			JobID:      job.ID,
			Type:       "job.retrying",
			Message:    fmt.Sprintf("retry scheduled at %s", retryAt.UTC().Format(time.RFC3339)),
			OccurredAt: finished,
		})
		if r.Metrics != nil {
			r.Metrics.RetriedTotal.Inc()
		}
		r.publish(ctx, domain.SystemEvent{
			Kind:      "job.retrying",
			JobID:     job.ID,
			Queue:     job.Queue,
			WorkerID:  r.WorkerStatus.WorkerID,
			State:     domain.JobStateRetrying,
			Timestamp: finished,
		})
		return
	}

	if err := r.Repo.MarkJobFailed(ctx, job); err != nil {
		r.Log.Error("failed to persist failed job", "job_id", job.ID, "error", err)
	}
	_ = r.Repo.UpdateIdempotencyOutcome(ctx, job, "failed")
	_ = r.Repo.UpsertJobAttempt(ctx, domain.JobAttempt{
		JobID:        job.ID,
		Attempt:      job.Attempts,
		WorkerID:     r.WorkerStatus.WorkerID,
		LeaseToken:   leaseToken,
		Status:       "failed",
		ErrorType:    fmt.Sprintf("%T", processingErr),
		ErrorMessage: job.LastError,
		StackTrace:   string(debug.Stack()),
		StartedAt:    *job.StartedAt,
		FinishedAt:   &finished,
	})
	_ = r.Repo.UpsertDeadLetter(ctx, domain.DeadLetter{
		JobID:        job.ID,
		Queue:        job.Queue,
		WorkerID:     r.WorkerStatus.WorkerID,
		ErrorType:    fmt.Sprintf("%T", processingErr),
		ErrorMessage: job.LastError,
		StackTrace:   string(debug.Stack()),
		FailedAt:     finished,
		LastAttempt:  job.Attempts,
	})
	_ = r.Repo.RecordJobEvent(ctx, domain.JobEvent{
		JobID:      job.ID,
		Type:       "job.failed",
		Message:    job.LastError,
		OccurredAt: finished,
	})
	if r.Metrics != nil {
		r.Metrics.FailedTotal.Inc()
		r.Metrics.DeadLetteredTotal.Inc()
	}
	r.publish(ctx, domain.SystemEvent{
		Kind:      "job.failed",
		JobID:     job.ID,
		Queue:     job.Queue,
		WorkerID:  r.WorkerStatus.WorkerID,
		State:     domain.JobStateFailed,
		Timestamp: finished,
	})
	r.resolveDependents(ctx, job, false, finished)
}

func (r *Runtime) heartbeatLoop(ctx context.Context, job domain.Job, leaseToken string, policies []domain.RateLimitPolicy, done <-chan struct{}) {
	ticker := time.NewTicker(r.HeartbeatInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-done:
			return
		case <-ticker.C:
			ok, err := r.Broker.Heartbeat(ctx, job.ID, leaseToken, r.WorkerStatus.WorkerID, r.LeaseTTL)
			if err != nil {
				r.Log.Warn("job heartbeat failed", "job_id", job.ID, "error", err)
				return
			}
			if !ok {
				r.Log.Warn("job lease heartbeat rejected", "job_id", job.ID)
				return
			}
			heartbeatAt := time.Now().UTC()
			leaseExpiresAt := heartbeatAt.Add(r.LeaseTTL)
			_ = r.Repo.UpdateJobHeartbeat(ctx, job.ID, r.WorkerStatus.WorkerID, heartbeatAt, leaseExpiresAt)
			_ = r.Repo.RecordJobEvent(ctx, domain.JobEvent{
				JobID:      job.ID,
				Type:       "job.heartbeat",
				Message:    fmt.Sprintf("worker %s renewed lease", r.WorkerStatus.WorkerID),
				OccurredAt: heartbeatAt,
			})
			if r.Limiter != nil && len(policies) > 0 {
				if err := r.Limiter.Renew(ctx, job, policies, r.LeaseTTL); err != nil {
					r.Log.Warn("rate limiter renewal failed", "job_id", job.ID, "error", err)
				}
			}
		}
	}
}

func (r *Runtime) workerHeartbeat(ctx context.Context) {
	ticker := time.NewTicker(r.HeartbeatInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := r.updateWorker(ctx, "running"); err != nil {
				r.Log.Warn("worker heartbeat failed", "error", err)
			}
		}
	}
}

func (r *Runtime) updateWorker(ctx context.Context, status string) error {
	record := r.WorkerStatus
	record.Status = status
	record.LastSeenAt = time.Now().UTC()
	if record.StartedAt.IsZero() {
		record.StartedAt = record.LastSeenAt
	}
	if r.Metrics != nil {
		r.Metrics.WorkerHeartbeats.Inc()
		r.Metrics.WorkerHeartbeatAge.WithLabelValues(record.WorkerID).Set(0)
	}
	if err := r.Repo.UpsertWorker(ctx, record); err != nil {
		return err
	}
	r.publish(ctx, domain.SystemEvent{
		Kind:       "worker.heartbeat",
		WorkerID:   record.WorkerID,
		Timestamp:  record.LastSeenAt,
		WorkerInfo: &record,
	})
	return nil
}

func (r *Runtime) policyRefreshLoop(ctx context.Context) {
	if r.Limiter == nil {
		return
	}
	if r.PolicyRefreshInterval <= 0 {
		r.PolicyRefreshInterval = 5 * time.Second
	}
	_ = r.refreshPolicies(ctx)
	ticker := time.NewTicker(r.PolicyRefreshInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := r.refreshPolicies(ctx); err != nil {
				r.Log.Warn("failed to refresh rate-limit policies", "error", err)
			}
		}
	}
}

func (r *Runtime) refreshPolicies(ctx context.Context) error {
	policies, err := r.Repo.ListRateLimitPolicies(ctx)
	if err != nil {
		return err
	}
	r.mu.Lock()
	r.policies = policies
	r.mu.Unlock()
	return nil
}

func (r *Runtime) currentPolicies() []domain.RateLimitPolicy {
	r.mu.RLock()
	defer r.mu.RUnlock()
	policies := make([]domain.RateLimitPolicy, len(r.policies))
	copy(policies, r.policies)
	return policies
}

func (r *Runtime) throttle(ctx context.Context, job domain.Job, leaseToken string, retryAt time.Time, reason string) {
	job.State = domain.JobStateThrottled
	job.LastError = reason
	job.UpdatedAt = time.Now().UTC()
	job.ThrottleUntil = &retryAt
	job.RunAt = retryAt
	ok, err := r.Broker.RequeueThrottled(ctx, job, leaseToken, retryAt, reason)
	if err != nil {
		r.Log.Error("failed to throttle job", "job_id", job.ID, "error", err)
		return
	}
	if !ok {
		r.Log.Warn("lease lost before throttling", "job_id", job.ID)
		return
	}
	_ = r.Repo.MarkJobThrottled(ctx, job)
	_ = r.Repo.RecordJobEvent(ctx, domain.JobEvent{
		JobID:      job.ID,
		Type:       "job.throttled",
		Message:    reason,
		OccurredAt: job.UpdatedAt,
	})
	if r.Metrics != nil {
		r.Metrics.ThrottledTotal.Inc()
	}
	r.publish(ctx, domain.SystemEvent{
		Kind:      "job.throttled",
		JobID:     job.ID,
		Queue:     job.Queue,
		WorkerID:  r.WorkerStatus.WorkerID,
		State:     domain.JobStateThrottled,
		Timestamp: job.UpdatedAt,
	})
}

func throttleReason(reasons []domain.ThrottleReason) string {
	if len(reasons) == 0 {
		return "job throttled"
	}
	parts := make([]string, 0, len(reasons))
	for _, reason := range reasons {
		parts = append(parts, reason.Message)
	}
	return strings.Join(parts, "; ")
}

func (r *Runtime) publish(ctx context.Context, event domain.SystemEvent) {
	if r.Bus == nil {
		return
	}
	if err := r.Bus.Publish(ctx, event); err != nil {
		r.Log.Warn("failed to publish event", "kind", event.Kind, "error", err)
	}
}

func waitFor(wg *sync.WaitGroup, timeout time.Duration) {
	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(timeout):
	}
}

func sleepOrDone(ctx context.Context, duration time.Duration) {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
	case <-timer.C:
	}
}
