package scheduler

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"distributed-job-system/libs/backend/domain"
	"distributed-job-system/libs/backend/metrics"
	"distributed-job-system/libs/backend/service"

	"github.com/robfig/cron/v3"
)

type JobEnqueuer interface {
	EnqueueJob(context.Context, domain.JobRequest) (domain.EnqueueResult, error)
}

type LeaderElector interface {
	TryAcquire(context.Context, string, time.Duration, string) (string, bool, error)
	Release(context.Context, string) error
	ClaimScheduleDispatch(context.Context, string, time.Time, time.Duration) (bool, error)
}

type Service struct {
	Repo                service.Repository
	Broker              service.Broker
	Bus                 service.Publisher
	Enqueuer            JobEnqueuer
	Metrics             *metrics.Metrics
	Log                 *slog.Logger
	ActivationBatchSize int64
	RecoveryBatchSize   int64
	ActivationInterval  time.Duration
	RecoveryInterval    time.Duration
	CronPollInterval    time.Duration
	SchedulerID         string
	LeadershipTTL       time.Duration
	Leader              LeaderElector
	leaderToken         string
	isLeader            bool
}

func (s *Service) Run(ctx context.Context) error {
	activationTicker := time.NewTicker(s.ActivationInterval)
	recoveryTicker := time.NewTicker(s.RecoveryInterval)
	cronTicker := time.NewTicker(s.CronPollInterval)
	leaderTicker := time.NewTicker(maxDuration(s.LeadershipTTL/3, time.Second))
	defer activationTicker.Stop()
	defer recoveryTicker.Stop()
	defer cronTicker.Stop()
	defer leaderTicker.Stop()
	defer func() {
		if s.Leader != nil {
			_ = s.Leader.Release(context.Background(), s.leaderToken)
		}
	}()

	for {
		select {
		case <-ctx.Done():
			return nil
		case <-leaderTicker.C:
			if err := s.ensureLeadership(ctx); err != nil {
				s.Log.Warn("failed to refresh scheduler leadership", "error", err)
			}
		case <-activationTicker.C:
			if !s.shouldRun(ctx) {
				continue
			}
			if err := s.activateDue(ctx); err != nil {
				s.Log.Warn("failed to activate due jobs", "error", err)
			}
		case <-recoveryTicker.C:
			if !s.shouldRun(ctx) {
				continue
			}
			if err := s.recoverExpired(ctx); err != nil {
				s.Log.Warn("failed to recover expired leases", "error", err)
			}
		case <-cronTicker.C:
			if !s.shouldRun(ctx) {
				continue
			}
			if err := s.runDueSchedules(ctx); err != nil {
				s.Log.Warn("failed to execute due schedules", "error", err)
			}
		}
	}
}

func (s *Service) activateDue(ctx context.Context) error {
	jobIDs, err := s.Broker.ActivateDue(ctx, s.ActivationBatchSize, time.Now().UTC())
	if err != nil {
		return err
	}
	for _, jobID := range jobIDs {
		job, loadErr := s.Broker.LoadJob(ctx, jobID)
		if loadErr != nil {
			s.Log.Warn("failed to load activated job", "job_id", jobID, "error", loadErr)
			continue
		}
		if err := s.Repo.MarkJobQueued(ctx, job); err != nil {
			s.Log.Warn("failed to mark activated job queued", "job_id", jobID, "error", err)
		}
		_ = s.Repo.RecordJobEvent(ctx, domain.JobEvent{
			JobID:      job.ID,
			Type:       "job.activated",
			Message:    "delayed job moved to ready queue",
			OccurredAt: time.Now().UTC(),
		})
		s.publish(ctx, domain.SystemEvent{
			Kind:      "job.activated",
			JobID:     job.ID,
			Queue:     job.Queue,
			State:     domain.JobStateQueued,
			Timestamp: time.Now().UTC(),
		})
	}
	return nil
}

func (s *Service) recoverExpired(ctx context.Context) error {
	recovered, err := s.Broker.RecoverExpired(ctx, s.RecoveryBatchSize, time.Now().UTC())
	if err != nil {
		return err
	}
	for _, item := range recovered {
		job, loadErr := s.Broker.LoadJob(ctx, item.JobID)
		if loadErr != nil {
			s.Log.Warn("failed to load recovered job", "job_id", item.JobID, "error", loadErr)
			continue
		}
		switch item.State {
		case domain.JobStateRetrying:
			if item.RetryAt != nil {
				_ = s.Repo.MarkJobRetrying(ctx, job, *item.RetryAt)
			}
			_ = s.Repo.UpsertJobAttempt(ctx, domain.JobAttempt{
				JobID:        job.ID,
				Attempt:      job.Attempts,
				WorkerID:     job.WorkerID,
				Status:       "lease_expired",
				ErrorType:    "lease_expired",
				ErrorMessage: "lease expired",
				LeaseExpired: true,
				StartedAt:    valueOrNow(job.StartedAt),
				FinishedAt:   timeRef(time.Now().UTC()),
			})
			_ = s.Repo.RecordJobEvent(ctx, domain.JobEvent{
				JobID:      job.ID,
				Type:       "job.recovered",
				Message:    fmt.Sprintf("expired lease recovered into retry at %s", item.RetryAt.UTC().Format(time.RFC3339)),
				OccurredAt: time.Now().UTC(),
			})
		case domain.JobStateFailed:
			finished := time.Now().UTC()
			job.FinishedAt = &finished
			_ = s.Repo.MarkJobFailed(ctx, job)
			_ = s.Repo.UpsertDeadLetter(ctx, domain.DeadLetter{
				JobID:        job.ID,
				Queue:        job.Queue,
				WorkerID:     job.WorkerID,
				ErrorType:    "lease_expired",
				ErrorMessage: "lease expired",
				FailedAt:     finished,
				LastAttempt:  job.Attempts,
			})
			_ = s.Repo.UpdateIdempotencyOutcome(ctx, job, "failed")
			_ = s.Repo.RecordJobEvent(ctx, domain.JobEvent{
				JobID:      job.ID,
				Type:       "job.recovered_failed",
				Message:    "expired lease moved to dead letter queue",
				OccurredAt: finished,
			})
		case domain.JobStateCanceled:
			finished := time.Now().UTC()
			job.FinishedAt = &finished
			job.CancelRequested = true
			_ = s.Repo.MarkJobCanceled(ctx, job)
		}
		if s.Enqueuer != nil {
			// no-op placeholder to keep interface usage explicit for recoveries
		}
		if s.Metrics != nil {
			s.Metrics.LeaseRecoveredTotal.Inc()
			if item.State == domain.JobStateFailed {
				s.Metrics.DeadLetteredTotal.Inc()
			}
		}
		s.publish(ctx, domain.SystemEvent{
			Kind:      "job.recovered",
			JobID:     job.ID,
			Queue:     job.Queue,
			State:     item.State,
			Timestamp: time.Now().UTC(),
		})
	}
	return nil
}

func (s *Service) runDueSchedules(ctx context.Context) error {
	now := time.Now().UTC()
	schedules, err := s.Repo.ListDueSchedules(ctx, now)
	if err != nil {
		return err
	}
	for _, schedule := range schedules {
		dispatchSlot := schedule.NextRunAt
		if s.Leader != nil {
			claimed, claimErr := s.Leader.ClaimScheduleDispatch(ctx, schedule.ID, dispatchSlot, 24*time.Hour)
			if claimErr != nil {
				s.Log.Warn("failed to claim schedule dispatch", "schedule", schedule.Name, "error", claimErr)
				continue
			}
			if !claimed {
				continue
			}
		}
		priority := schedule.Priority
		if _, err := s.Enqueuer.EnqueueJob(ctx, domain.JobRequest{
			Type:           schedule.Type,
			Queue:          schedule.Queue,
			Payload:        schedule.Payload,
			Priority:       &priority,
			MaxAttempts:    schedule.MaxAttempts,
			TimeoutSeconds: schedule.TimeoutSeconds,
		}); err != nil {
			s.Log.Warn("failed to enqueue scheduled job", "schedule", schedule.Name, "error", err)
			continue
		}
		nextRun, err := nextRun(schedule, now)
		if err != nil {
			s.Log.Warn("failed to compute next schedule", "schedule", schedule.Name, "error", err)
			continue
		}
		if err := s.Repo.UpdateScheduleRun(ctx, schedule.ID, now, nextRun); err != nil {
			s.Log.Warn("failed to persist schedule next run", "schedule", schedule.Name, "error", err)
		}
		s.publish(ctx, domain.SystemEvent{
			Kind:      "schedule.executed",
			Message:   schedule.Name,
			Timestamp: now,
		})
	}
	return nil
}

func (s *Service) shouldRun(ctx context.Context) bool {
	if s.Leader == nil {
		return true
	}
	if err := s.ensureLeadership(ctx); err != nil {
		s.Log.Warn("scheduler leadership check failed", "error", err)
		return false
	}
	return s.isLeader
}

func (s *Service) ensureLeadership(ctx context.Context) error {
	if s.Leader == nil {
		s.isLeader = true
		return nil
	}
	token, acquired, err := s.Leader.TryAcquire(ctx, s.SchedulerID, s.LeadershipTTL, s.leaderToken)
	if err != nil {
		return err
	}
	if acquired && (!s.isLeader || token != s.leaderToken) {
		s.publish(ctx, domain.SystemEvent{
			Kind:      "scheduler.leader_acquired",
			WorkerID:  s.SchedulerID,
			Timestamp: time.Now().UTC(),
		})
	}
	if !acquired && s.isLeader {
		s.publish(ctx, domain.SystemEvent{
			Kind:      "scheduler.leader_lost",
			WorkerID:  s.SchedulerID,
			Timestamp: time.Now().UTC(),
		})
	}
	s.leaderToken = token
	s.isLeader = acquired
	return nil
}

func nextRun(schedule domain.Schedule, now time.Time) (time.Time, error) {
	location := time.UTC
	if schedule.Timezone != "" {
		loaded, err := time.LoadLocation(schedule.Timezone)
		if err != nil {
			return time.Time{}, err
		}
		location = loaded
	}
	spec, err := cron.ParseStandard(schedule.CronExpression)
	if err != nil {
		return time.Time{}, err
	}
	return spec.Next(now.In(location)).UTC(), nil
}

func (s *Service) publish(ctx context.Context, event domain.SystemEvent) {
	if s.Bus == nil {
		return
	}
	if err := s.Bus.Publish(ctx, event); err != nil {
		s.Log.Warn("failed to publish event", "kind", event.Kind, "error", err)
	}
}

func valueOrNow(value *time.Time) time.Time {
	if value == nil {
		return time.Now().UTC()
	}
	return value.UTC()
}

func timeRef(value time.Time) *time.Time {
	return &value
}

func maxDuration(a, b time.Duration) time.Duration {
	if a > b {
		return a
	}
	return b
}
