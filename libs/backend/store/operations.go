package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"distributed-job-system/libs/backend/domain"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

const jobSelectColumns = `
	id, type, queue, tenant_id, payload, priority, state, attempts, max_attempts, schema_version,
	idempotency_key, workflow_id, parent_job_id, dependency_policy, blocked_reason, run_at,
	created_at, updated_at, started_at, finished_at, last_heartbeat_at, lease_expires_at,
	throttle_until, last_error, result, worker_id, lease_token, timeout_seconds, cancel_requested,
	execution_ms
`

func (r *PostgresRepository) CreateJobBundle(ctx context.Context, job domain.Job, dependencies []string) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() {
		if tx != nil {
			_ = tx.Rollback(ctx)
		}
	}()

	if err := insertJobTx(ctx, tx, job); err != nil {
		return err
	}
	if err := insertDependenciesTx(ctx, tx, job.ID, dependencies); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	tx = nil
	return nil
}

func (r *PostgresRepository) CreateJobWithIdempotency(ctx context.Context, job domain.Job, dependencies []string, dedupeWindow time.Duration) (domain.EnqueueResult, error) {
	scope := domain.IdempotencyScope(job.TenantID, job.Type, job.IdempotencyKey)
	now := job.CreatedAt
	if dedupeWindow <= 0 {
		dedupeWindow = 15 * time.Minute
	}

	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return domain.EnqueueResult{}, err
	}
	defer func() {
		if tx != nil {
			_ = tx.Rollback(ctx)
		}
	}()

	record, err := getIdempotencyRecordForUpdateTx(ctx, tx, scope)
	switch {
	case err == nil && record.ExpiresAt.After(now):
		existingJob, loadErr := loadJobTx(ctx, tx, record.JobID)
		if loadErr != nil {
			return domain.EnqueueResult{}, loadErr
		}
		if err := tx.Commit(ctx); err != nil {
			return domain.EnqueueResult{}, err
		}
		tx = nil
		return domain.EnqueueResult{
			Job:                 existingJob,
			DuplicateSuppressed: true,
			Idempotency:         &record,
		}, nil
	case err == nil:
		if _, deleteErr := tx.Exec(ctx, `DELETE FROM idempotency_records WHERE scope = $1`, scope); deleteErr != nil {
			return domain.EnqueueResult{}, deleteErr
		}
	case err != nil && err != pgx.ErrNoRows:
		return domain.EnqueueResult{}, err
	}

	if err := insertJobTx(ctx, tx, job); err != nil {
		return domain.EnqueueResult{}, err
	}
	if err := insertDependenciesTx(ctx, tx, job.ID, dependencies); err != nil {
		return domain.EnqueueResult{}, err
	}

	record = domain.IdempotencyRecord{
		Scope:          scope,
		TenantID:       job.TenantID,
		JobType:        job.Type,
		IdempotencyKey: job.IdempotencyKey,
		JobID:          job.ID,
		Status:         "accepted",
		FirstSeenAt:    now,
		UpdatedAt:      now,
		ExpiresAt:      now.Add(dedupeWindow),
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO idempotency_records (
			scope, tenant_id, job_type, idempotency_key, job_id, status, first_seen_at, updated_at, expires_at
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
	`, record.Scope, record.TenantID, record.JobType, record.IdempotencyKey, record.JobID, record.Status, record.FirstSeenAt, record.UpdatedAt, record.ExpiresAt); err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			_ = tx.Rollback(ctx)
			tx = nil
			existingRecord, getErr := r.GetIdempotencyRecord(ctx, scope)
			if getErr != nil {
				return domain.EnqueueResult{}, getErr
			}
			existingJob, loadErr := r.GetJob(ctx, existingRecord.JobID)
			if loadErr != nil {
				return domain.EnqueueResult{}, loadErr
			}
			return domain.EnqueueResult{
				Job:                 existingJob,
				DuplicateSuppressed: true,
				Idempotency:         &existingRecord,
			}, nil
		}
		return domain.EnqueueResult{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return domain.EnqueueResult{}, err
	}
	tx = nil

	return domain.EnqueueResult{
		Job:         job,
		Idempotency: &record,
	}, nil
}

func (r *PostgresRepository) GetIdempotencyRecord(ctx context.Context, scope string) (domain.IdempotencyRecord, error) {
	return getIdempotencyRecordTx(ctx, r.pool, scope)
}

func (r *PostgresRepository) UpdateIdempotencyOutcome(ctx context.Context, job domain.Job, status string) error {
	if job.IdempotencyKey == "" {
		return nil
	}
	now := time.Now().UTC()
	_, err := r.pool.Exec(ctx, `
		UPDATE idempotency_records
		SET outcome = $2,
			status = $3,
			updated_at = $4
		WHERE job_id = $1
	`, job.ID, json.RawMessage(job.Result), status, now)
	return err
}

func (r *PostgresRepository) CreateJobDependencies(ctx context.Context, jobID string, dependencies []string) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() {
		if tx != nil {
			_ = tx.Rollback(ctx)
		}
	}()
	if err := insertDependenciesTx(ctx, tx, jobID, dependencies); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	tx = nil
	return nil
}

func (r *PostgresRepository) ListDependencies(ctx context.Context, jobID string) ([]domain.JobDependency, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT job_id, depends_on_job_id
		FROM job_dependencies
		WHERE job_id = $1
		ORDER BY depends_on_job_id
	`, jobID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var dependencies []domain.JobDependency
	for rows.Next() {
		var edge domain.JobDependency
		if err := rows.Scan(&edge.JobID, &edge.DependsOnJobID); err != nil {
			return nil, err
		}
		dependencies = append(dependencies, edge)
	}
	return dependencies, rows.Err()
}

func (r *PostgresRepository) ListDependentJobs(ctx context.Context, dependsOnJobID string) ([]domain.Job, error) {
	rows, err := r.pool.Query(ctx, fmt.Sprintf(`
		SELECT %s
		FROM jobs
		WHERE id IN (
			SELECT job_id
			FROM job_dependencies
			WHERE depends_on_job_id = $1
		)
		ORDER BY created_at ASC
	`, jobSelectColumns), dependsOnJobID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var jobs []domain.Job
	for rows.Next() {
		job, err := scanJob(rows)
		if err != nil {
			return nil, err
		}
		jobs = append(jobs, job)
	}
	return jobs, rows.Err()
}

func (r *PostgresRepository) ListJobEvents(ctx context.Context, jobID string, limit int) ([]domain.JobEvent, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := r.pool.Query(ctx, `
		SELECT job_id, type, message, metadata, occurred_at
		FROM job_events
		WHERE job_id = $1
		ORDER BY occurred_at DESC
		LIMIT $2
	`, jobID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	events := make([]domain.JobEvent, 0, limit)
	for rows.Next() {
		var event domain.JobEvent
		var metadata []byte
		if err := rows.Scan(&event.JobID, &event.Type, &event.Message, &metadata, &event.OccurredAt); err != nil {
			return nil, err
		}
		event.Metadata = metadata
		events = append(events, event)
	}
	return events, rows.Err()
}

func (r *PostgresRepository) UpsertJobAttempt(ctx context.Context, attempt domain.JobAttempt) error {
	_, err := r.pool.Exec(ctx, `
		INSERT INTO job_attempts (
			job_id, attempt, worker_id, lease_token, status, error_type, error_message, stack_trace,
			lease_expired, started_at, finished_at
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
		ON CONFLICT (job_id, attempt) DO UPDATE
		SET worker_id = EXCLUDED.worker_id,
			lease_token = EXCLUDED.lease_token,
			status = EXCLUDED.status,
			error_type = EXCLUDED.error_type,
			error_message = EXCLUDED.error_message,
			stack_trace = EXCLUDED.stack_trace,
			lease_expired = EXCLUDED.lease_expired,
			started_at = EXCLUDED.started_at,
			finished_at = EXCLUDED.finished_at
	`, attempt.JobID, attempt.Attempt, attempt.WorkerID, attempt.LeaseToken, attempt.Status, attempt.ErrorType, attempt.ErrorMessage, attempt.StackTrace, attempt.LeaseExpired, attempt.StartedAt, attempt.FinishedAt)
	return err
}

func (r *PostgresRepository) ListJobAttempts(ctx context.Context, jobID string) ([]domain.JobAttempt, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT id, job_id, attempt, worker_id, lease_token, status, error_type, error_message, stack_trace,
		       lease_expired, started_at, finished_at
		FROM job_attempts
		WHERE job_id = $1
		ORDER BY attempt DESC
	`, jobID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var attempts []domain.JobAttempt
	for rows.Next() {
		var attempt domain.JobAttempt
		if err := rows.Scan(
			&attempt.ID,
			&attempt.JobID,
			&attempt.Attempt,
			&attempt.WorkerID,
			&attempt.LeaseToken,
			&attempt.Status,
			&attempt.ErrorType,
			&attempt.ErrorMessage,
			&attempt.StackTrace,
			&attempt.LeaseExpired,
			&attempt.StartedAt,
			&attempt.FinishedAt,
		); err != nil {
			return nil, err
		}
		attempts = append(attempts, attempt)
	}
	return attempts, rows.Err()
}

func (r *PostgresRepository) UpsertDeadLetter(ctx context.Context, deadLetter domain.DeadLetter) error {
	_, err := r.pool.Exec(ctx, `
		INSERT INTO dead_letters (
			job_id, queue, worker_id, error_type, error_message, stack_trace, failed_at, last_attempt,
			replay_count, last_replayed_at
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
		ON CONFLICT (job_id) DO UPDATE
		SET queue = EXCLUDED.queue,
			worker_id = EXCLUDED.worker_id,
			error_type = EXCLUDED.error_type,
			error_message = EXCLUDED.error_message,
			stack_trace = EXCLUDED.stack_trace,
			failed_at = EXCLUDED.failed_at,
			last_attempt = EXCLUDED.last_attempt,
			replay_count = EXCLUDED.replay_count,
			last_replayed_at = EXCLUDED.last_replayed_at
	`, deadLetter.JobID, deadLetter.Queue, deadLetter.WorkerID, deadLetter.ErrorType, deadLetter.ErrorMessage, deadLetter.StackTrace, deadLetter.FailedAt, deadLetter.LastAttempt, deadLetter.ReplayCount, deadLetter.LastReplayedAt)
	return err
}

func (r *PostgresRepository) ListDeadLetters(ctx context.Context, filter domain.DeadLetterFilter) ([]domain.DeadLetter, error) {
	limit := filter.Limit
	if limit <= 0 || limit > 500 {
		limit = 100
	}

	query := `
		SELECT job_id, queue, worker_id, error_type, error_message, stack_trace, failed_at, last_attempt,
		       replay_count, last_replayed_at
		FROM dead_letters
		WHERE 1 = 1
	`
	args := make([]interface{}, 0, 3)
	if filter.Queue != "" {
		args = append(args, filter.Queue)
		query += fmt.Sprintf(" AND queue = $%d", len(args))
	}
	if filter.ErrorType != "" {
		args = append(args, filter.ErrorType)
		query += fmt.Sprintf(" AND error_type = $%d", len(args))
	}
	args = append(args, limit)
	query += fmt.Sprintf(" ORDER BY failed_at DESC LIMIT $%d", len(args))

	rows, err := r.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []domain.DeadLetter
	for rows.Next() {
		var deadLetter domain.DeadLetter
		if err := rows.Scan(
			&deadLetter.JobID,
			&deadLetter.Queue,
			&deadLetter.WorkerID,
			&deadLetter.ErrorType,
			&deadLetter.ErrorMessage,
			&deadLetter.StackTrace,
			&deadLetter.FailedAt,
			&deadLetter.LastAttempt,
			&deadLetter.ReplayCount,
			&deadLetter.LastReplayedAt,
		); err != nil {
			return nil, err
		}
		job, err := r.GetJob(ctx, deadLetter.JobID)
		if err == nil {
			deadLetter.Job = &job
		}
		attempts, attemptErr := r.ListJobAttempts(ctx, deadLetter.JobID)
		if attemptErr == nil {
			deadLetter.Attempts = attempts
		}
		out = append(out, deadLetter)
	}
	return out, rows.Err()
}

func (r *PostgresRepository) GetDeadLetter(ctx context.Context, jobID string) (domain.DeadLetter, error) {
	var deadLetter domain.DeadLetter
	err := r.pool.QueryRow(ctx, `
		SELECT job_id, queue, worker_id, error_type, error_message, stack_trace, failed_at, last_attempt,
		       replay_count, last_replayed_at
		FROM dead_letters
		WHERE job_id = $1
	`, jobID).Scan(
		&deadLetter.JobID,
		&deadLetter.Queue,
		&deadLetter.WorkerID,
		&deadLetter.ErrorType,
		&deadLetter.ErrorMessage,
		&deadLetter.StackTrace,
		&deadLetter.FailedAt,
		&deadLetter.LastAttempt,
		&deadLetter.ReplayCount,
		&deadLetter.LastReplayedAt,
	)
	if err != nil {
		return domain.DeadLetter{}, err
	}

	job, jobErr := r.GetJob(ctx, deadLetter.JobID)
	if jobErr == nil {
		deadLetter.Job = &job
	}
	attempts, attemptErr := r.ListJobAttempts(ctx, deadLetter.JobID)
	if attemptErr == nil {
		deadLetter.Attempts = attempts
	}

	return deadLetter, nil
}

func (r *PostgresRepository) DeleteDeadLetters(ctx context.Context, jobIDs []string) error {
	if len(jobIDs) == 0 {
		return nil
	}
	_, err := r.pool.Exec(ctx, `DELETE FROM dead_letters WHERE job_id = ANY($1::uuid[])`, jobIDs)
	return err
}

func (r *PostgresRepository) RecordDeadLetterAction(ctx context.Context, action domain.DeadLetterAction) error {
	_, err := r.pool.Exec(ctx, `
		INSERT INTO dead_letter_actions (job_id, action, actor, from_queue, to_queue, payload_before, payload_after, occurred_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
	`, action.JobID, action.Action, action.Actor, action.FromQueue, action.ToQueue, json.RawMessage(action.PayloadBefore), json.RawMessage(action.PayloadAfter), action.OccurredAt)
	return err
}

func (r *PostgresRepository) MarkJobThrottled(ctx context.Context, job domain.Job) error {
	_, err := r.pool.Exec(ctx, `
		UPDATE jobs
		SET state = $2,
			last_error = $3,
			throttle_until = $4,
			updated_at = $5,
			worker_id = '',
			lease_token = '',
			lease_expires_at = NULL
		WHERE id = $1
	`, job.ID, string(job.State), job.LastError, job.ThrottleUntil, job.UpdatedAt)
	return err
}

func (r *PostgresRepository) UpdateJobHeartbeat(ctx context.Context, jobID, workerID string, heartbeatAt, leaseExpiresAt time.Time) error {
	_, err := r.pool.Exec(ctx, `
		UPDATE jobs
		SET worker_id = $2,
			last_heartbeat_at = $3,
			lease_expires_at = $4,
			updated_at = $3
		WHERE id = $1
	`, jobID, workerID, heartbeatAt, leaseExpiresAt)
	return err
}

func (r *PostgresRepository) ListBlockedJobs(ctx context.Context, limit int) ([]domain.Job, error) {
	return r.ListJobs(ctx, domain.ListJobsFilter{State: domain.JobStateBlocked, Limit: limit})
}

func (r *PostgresRepository) ListThrottledJobs(ctx context.Context, limit int) ([]domain.Job, error) {
	return r.ListJobs(ctx, domain.ListJobsFilter{State: domain.JobStateThrottled, Limit: limit})
}

func (r *PostgresRepository) ListRateLimitPolicies(ctx context.Context) ([]domain.RateLimitPolicy, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT id, name, scope, scope_value, mode, limit_value, window_seconds, burst, enabled, created_at, updated_at
		FROM rate_limit_policies
		ORDER BY name ASC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var policies []domain.RateLimitPolicy
	for rows.Next() {
		var policy domain.RateLimitPolicy
		if err := rows.Scan(
			&policy.ID,
			&policy.Name,
			&policy.Scope,
			&policy.ScopeValue,
			&policy.Mode,
			&policy.Limit,
			&policy.WindowSeconds,
			&policy.Burst,
			&policy.Enabled,
			&policy.CreatedAt,
			&policy.UpdatedAt,
		); err != nil {
			return nil, err
		}
		policies = append(policies, policy)
	}
	return policies, rows.Err()
}

func (r *PostgresRepository) UpsertRateLimitPolicy(ctx context.Context, policy domain.RateLimitPolicy) (domain.RateLimitPolicy, error) {
	if policy.ID == "" {
		policy.ID = uuid.NewString()
	}
	if policy.CreatedAt.IsZero() {
		policy.CreatedAt = time.Now().UTC()
	}
	policy.UpdatedAt = time.Now().UTC()
	_, err := r.pool.Exec(ctx, `
		INSERT INTO rate_limit_policies (
			id, name, scope, scope_value, mode, limit_value, window_seconds, burst, enabled, created_at, updated_at
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
		ON CONFLICT (id) DO UPDATE
		SET name = EXCLUDED.name,
			scope = EXCLUDED.scope,
			scope_value = EXCLUDED.scope_value,
			mode = EXCLUDED.mode,
			limit_value = EXCLUDED.limit_value,
			window_seconds = EXCLUDED.window_seconds,
			burst = EXCLUDED.burst,
			enabled = EXCLUDED.enabled,
			updated_at = EXCLUDED.updated_at
	`, policy.ID, policy.Name, policy.Scope, policy.ScopeValue, policy.Mode, policy.Limit, policy.WindowSeconds, policy.Burst, policy.Enabled, policy.CreatedAt, policy.UpdatedAt)
	if err != nil {
		return domain.RateLimitPolicy{}, err
	}
	return policy, nil
}

func (r *PostgresRepository) GetDependencyGraph(ctx context.Context, rootJobID string) (domain.DependencyGraph, error) {
	rows, err := r.pool.Query(ctx, fmt.Sprintf(`
		WITH RECURSIVE graph AS (
			SELECT id
			FROM jobs
			WHERE id = $1::uuid
			UNION
			SELECT d.job_id
			FROM job_dependencies d
			JOIN graph g ON g.id = d.depends_on_job_id
			UNION
			SELECT d.depends_on_job_id
			FROM job_dependencies d
			JOIN graph g ON g.id = d.job_id
		)
		SELECT %s
		FROM jobs
		WHERE id IN (SELECT id FROM graph)
		ORDER BY created_at ASC
	`, jobSelectColumns), rootJobID)
	if err != nil {
		return domain.DependencyGraph{}, err
	}
	defer rows.Close()

	nodeMap := map[string]*domain.DependencyNode{}
	for rows.Next() {
		job, err := scanJob(rows)
		if err != nil {
			return domain.DependencyGraph{}, err
		}
		nodeMap[job.ID] = &domain.DependencyNode{
			JobID:            job.ID,
			Type:             job.Type,
			State:            job.State,
			Queue:            job.Queue,
			ParentJobID:      job.ParentJobID,
			WorkflowID:       job.WorkflowID,
			BlockedReason:    job.BlockedReason,
			DependencyPolicy: job.DependencyPolicy,
		}
	}

	edges, err := r.pool.Query(ctx, `
		SELECT job_id, depends_on_job_id
		FROM job_dependencies
		WHERE job_id IN (
			WITH RECURSIVE graph AS (
				SELECT id
				FROM jobs
				WHERE id = $1::uuid
				UNION
				SELECT d.job_id
				FROM job_dependencies d
				JOIN graph g ON g.id = d.depends_on_job_id
				UNION
				SELECT d.depends_on_job_id
				FROM job_dependencies d
				JOIN graph g ON g.id = d.job_id
			)
			SELECT id FROM graph
		)
	`, rootJobID)
	if err != nil {
		return domain.DependencyGraph{}, err
	}
	defer edges.Close()

	for edges.Next() {
		var jobID string
		var dependsOnJobID string
		if err := edges.Scan(&jobID, &dependsOnJobID); err != nil {
			return domain.DependencyGraph{}, err
		}
		if node := nodeMap[jobID]; node != nil {
			node.DependsOn = append(node.DependsOn, dependsOnJobID)
		}
		if node := nodeMap[dependsOnJobID]; node != nil {
			node.Dependents = append(node.Dependents, jobID)
		}
	}

	out := domain.DependencyGraph{RootJobID: rootJobID}
	for _, node := range nodeMap {
		out.Nodes = append(out.Nodes, *node)
	}
	return out, nil
}

func insertJobTx(ctx context.Context, tx pgx.Tx, job domain.Job) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO jobs (
			id, type, queue, tenant_id, payload, priority, state, attempts, max_attempts, schema_version,
			idempotency_key, workflow_id, parent_job_id, dependency_policy, blocked_reason, run_at,
			created_at, updated_at, throttle_until, lease_expires_at, timeout_seconds
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
	`, job.ID, job.Type, job.Queue, job.TenantID, json.RawMessage(job.Payload), job.Priority, string(job.State), job.Attempts, job.MaxAttempts, job.SchemaVersion, job.IdempotencyKey, job.WorkflowID, job.ParentJobID, string(job.DependencyPolicy.Normalize()), job.BlockedReason, job.RunAt, job.CreatedAt, job.UpdatedAt, job.ThrottleUntil, job.LeaseExpiresAt, job.TimeoutSeconds)
	return err
}

func insertDependenciesTx(ctx context.Context, tx pgx.Tx, jobID string, dependencies []string) error {
	for _, dependencyID := range dependencies {
		if dependencyID == "" {
			continue
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO job_dependencies (job_id, depends_on_job_id)
			VALUES ($1, $2)
			ON CONFLICT DO NOTHING
		`, jobID, dependencyID); err != nil {
			return err
		}
	}
	return nil
}

type idempotencyQueryable interface {
	QueryRow(context.Context, string, ...interface{}) pgx.Row
}

func getIdempotencyRecordTx(ctx context.Context, queryable idempotencyQueryable, scope string) (domain.IdempotencyRecord, error) {
	var record domain.IdempotencyRecord
	var outcome []byte
	err := queryable.QueryRow(ctx, `
		SELECT scope, tenant_id, job_type, idempotency_key, job_id, status, outcome, first_seen_at, updated_at, expires_at
		FROM idempotency_records
		WHERE scope = $1
	`, scope).Scan(&record.Scope, &record.TenantID, &record.JobType, &record.IdempotencyKey, &record.JobID, &record.Status, &outcome, &record.FirstSeenAt, &record.UpdatedAt, &record.ExpiresAt)
	if err != nil {
		if err == pgx.ErrNoRows {
			return domain.IdempotencyRecord{}, err
		}
		return domain.IdempotencyRecord{}, err
	}
	record.Outcome = outcome
	return record, nil
}

func getIdempotencyRecordForUpdateTx(ctx context.Context, tx pgx.Tx, scope string) (domain.IdempotencyRecord, error) {
	var record domain.IdempotencyRecord
	var outcome []byte
	err := tx.QueryRow(ctx, `
		SELECT scope, tenant_id, job_type, idempotency_key, job_id, status, outcome, first_seen_at, updated_at, expires_at
		FROM idempotency_records
		WHERE scope = $1
		FOR UPDATE
	`, scope).Scan(&record.Scope, &record.TenantID, &record.JobType, &record.IdempotencyKey, &record.JobID, &record.Status, &outcome, &record.FirstSeenAt, &record.UpdatedAt, &record.ExpiresAt)
	if err != nil {
		return domain.IdempotencyRecord{}, err
	}
	record.Outcome = outcome
	return record, nil
}

func loadJobTx(ctx context.Context, queryable idempotencyQueryable, jobID string) (domain.Job, error) {
	row := queryable.QueryRow(ctx, fmt.Sprintf(`SELECT %s FROM jobs WHERE id = $1`, jobSelectColumns), jobID)
	return scanJob(row)
}
