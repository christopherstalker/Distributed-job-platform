package worker

import (
	"context"
	"fmt"
	"time"

	"distributed-job-system/libs/backend/domain"
)

func (r *Runtime) resolveDependents(ctx context.Context, upstream domain.Job, succeeded bool, now time.Time) {
	dependents, err := r.Repo.ListDependentJobs(ctx, upstream.ID)
	if err != nil {
		r.Log.Warn("failed to list dependent jobs", "job_id", upstream.ID, "error", err)
		return
	}

	for _, dependent := range dependents {
		if dependent.State != domain.JobStateBlocked {
			continue
		}
		dependencies, err := r.Repo.ListDependencies(ctx, dependent.ID)
		if err != nil {
			r.Log.Warn("failed to list dependency edges", "job_id", dependent.ID, "error", err)
			continue
		}

		ready, blockedReason := r.dependencyReadiness(ctx, dependent, dependencies)
		if !ready {
			if blockedReason == "" {
				blockedReason = fmt.Sprintf("waiting on %d dependencies", len(dependencies))
			}
			if dependent.BlockedReason == blockedReason && dependent.State == domain.JobStateBlocked {
				continue
			}
			dependent.State = domain.JobStateBlocked
			dependent.BlockedReason = blockedReason
			dependent.UpdatedAt = now
			if err := r.Repo.MarkJobQueued(ctx, dependent); err != nil {
				r.Log.Warn("failed to persist blocked job", "job_id", dependent.ID, "error", err)
				continue
			}
			_ = r.Repo.RecordJobEvent(ctx, domain.JobEvent{
				JobID:      dependent.ID,
				Type:       "job.blocked",
				Message:    blockedReason,
				OccurredAt: now,
			})
			continue
		}

		dependent.BlockedReason = ""
		if dependent.RunAt.After(now) {
			dependent.State = domain.JobStateScheduled
		} else {
			dependent.State = domain.JobStateQueued
		}
		dependent.UpdatedAt = now
		if err := r.Broker.Enqueue(ctx, dependent); err != nil {
			r.Log.Warn("failed to enqueue unblocked dependent job", "job_id", dependent.ID, "error", err)
			continue
		}
		if err := r.Repo.MarkJobQueued(ctx, dependent); err != nil {
			r.Log.Warn("failed to persist unblocked job", "job_id", dependent.ID, "error", err)
			continue
		}
		_ = r.Repo.RecordJobEvent(ctx, domain.JobEvent{
			JobID:      dependent.ID,
			Type:       "job.unblocked",
			Message:    fmt.Sprintf("dependency chain satisfied by %s", upstream.ID),
			OccurredAt: now,
		})
		r.publish(ctx, domain.SystemEvent{
			Kind:      "job.unblocked",
			JobID:     dependent.ID,
			Queue:     dependent.Queue,
			State:     dependent.State,
			Timestamp: now,
		})
	}

	if !succeeded {
		r.publish(ctx, domain.SystemEvent{
			Kind:      "job.dependency_failed",
			JobID:     upstream.ID,
			Queue:     upstream.Queue,
			State:     upstream.State,
			Timestamp: now,
		})
	}
}

func (r *Runtime) dependencyReadiness(ctx context.Context, job domain.Job, dependencies []domain.JobDependency) (bool, string) {
	if len(dependencies) == 0 {
		return true, ""
	}

	allSatisfied := true
	policy := job.DependencyPolicy.Normalize()
	for _, dependency := range dependencies {
		dependencyJob, err := r.Repo.GetJob(ctx, dependency.DependsOnJobID)
		if err != nil {
			return false, fmt.Sprintf("dependency %s could not be loaded", dependency.DependsOnJobID)
		}
		switch policy {
		case domain.DependencyFailurePolicyAllowFailed:
			if dependencyJob.State != domain.JobStateCompleted &&
				dependencyJob.State != domain.JobStateFailed &&
				dependencyJob.State != domain.JobStateCanceled {
				allSatisfied = false
			}
		default:
			if dependencyJob.State == domain.JobStateFailed || dependencyJob.State == domain.JobStateCanceled {
				return false, fmt.Sprintf("dependency %s finished as %s", dependencyJob.ID, dependencyJob.State)
			}
			if dependencyJob.State != domain.JobStateCompleted {
				allSatisfied = false
			}
		}
	}
	if !allSatisfied {
		return false, fmt.Sprintf("waiting on %d dependencies", len(dependencies))
	}
	return true, ""
}
