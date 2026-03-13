package store

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"distributed-job-system/libs/backend/domain"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type PostgresRepository struct {
	pool *pgxpool.Pool
	log  *slog.Logger
}

func NewPool(ctx context.Context, url string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, err
	}
	cfg.MaxConns = 32
	cfg.MinConns = 4
	cfg.MaxConnLifetime = time.Hour
	cfg.MaxConnIdleTime = 10 * time.Minute
	return pgxpool.NewWithConfig(ctx, cfg)
}

func NewPostgresRepository(pool *pgxpool.Pool, log *slog.Logger) *PostgresRepository {
	return &PostgresRepository{pool: pool, log: log}
}

func (r *PostgresRepository) RunMigrations(ctx context.Context, dir string) error {
	if _, err := r.pool.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version text PRIMARY KEY,
			applied_at timestamptz NOT NULL DEFAULT now()
		)
	`); err != nil {
		return err
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	versions := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sql") {
			continue
		}
		versions = append(versions, entry.Name())
	}
	slices.Sort(versions)

	applied := map[string]struct{}{}
	rows, err := r.pool.Query(ctx, `SELECT version FROM schema_migrations`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var version string
		if err := rows.Scan(&version); err != nil {
			return err
		}
		applied[version] = struct{}{}
	}

	for _, version := range versions {
		if _, ok := applied[version]; ok {
			continue
		}
		path := filepath.Join(dir, version)
		sqlBytes, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		tx, err := r.pool.Begin(ctx)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, string(sqlBytes)); err != nil {
			_ = tx.Rollback(ctx)
			return fmt.Errorf("migration %s failed: %w", version, err)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO schema_migrations (version) VALUES ($1)`, version); err != nil {
			_ = tx.Rollback(ctx)
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		r.log.Info("applied migration", "version", version)
	}
	return nil
}

func (r *PostgresRepository) CreateJobs(ctx context.Context, jobs []domain.Job) error {
	if len(jobs) == 0 {
		return nil
	}
	rows := make([][]interface{}, 0, len(jobs))
	for _, job := range jobs {
		rows = append(rows, []interface{}{
			job.ID,
			job.Type,
			job.Queue,
			job.TenantID,
			json.RawMessage(job.Payload),
			job.Priority,
			string(job.State),
			job.Attempts,
			job.MaxAttempts,
			job.SchemaVersion,
			job.IdempotencyKey,
			job.WorkflowID,
			job.ParentJobID,
			string(job.DependencyPolicy.Normalize()),
			job.BlockedReason,
			job.RunAt,
			job.CreatedAt,
			job.UpdatedAt,
			job.ThrottleUntil,
			job.LeaseExpiresAt,
			job.TimeoutSeconds,
		})
	}
	_, err := r.pool.CopyFrom(
		ctx,
		pgx.Identifier{"jobs"},
		[]string{
			"id",
			"type",
			"queue",
			"tenant_id",
			"payload",
			"priority",
			"state",
			"attempts",
			"max_attempts",
			"schema_version",
			"idempotency_key",
			"workflow_id",
			"parent_job_id",
			"dependency_policy",
			"blocked_reason",
			"run_at",
			"created_at",
			"updated_at",
			"throttle_until",
			"lease_expires_at",
			"timeout_seconds",
		},
		pgx.CopyFromRows(rows),
	)
	return err
}

func (r *PostgresRepository) GetJob(ctx context.Context, jobID string) (domain.Job, error) {
	row := r.pool.QueryRow(ctx, `
		SELECT id, type, queue, tenant_id, payload, priority, state, attempts, max_attempts, schema_version,
		       idempotency_key, workflow_id, parent_job_id, dependency_policy, blocked_reason, run_at,
		       created_at, updated_at, started_at, finished_at, last_heartbeat_at, lease_expires_at,
		       throttle_until, last_error, result, worker_id, lease_token,
		       timeout_seconds, cancel_requested, execution_ms
		FROM jobs
		WHERE id = $1
	`, jobID)
	return scanJob(row)
}

func (r *PostgresRepository) ListJobs(ctx context.Context, filter domain.ListJobsFilter) ([]domain.Job, error) {
	query := `
		SELECT id, type, queue, tenant_id, payload, priority, state, attempts, max_attempts, schema_version,
		       idempotency_key, workflow_id, parent_job_id, dependency_policy, blocked_reason, run_at,
		       created_at, updated_at, started_at, finished_at, last_heartbeat_at, lease_expires_at,
		       throttle_until, last_error, result, worker_id, lease_token,
		       timeout_seconds, cancel_requested, execution_ms
		FROM jobs
		WHERE 1=1
	`
	args := make([]interface{}, 0, 4)
	if filter.State != "" {
		args = append(args, string(filter.State))
		query += fmt.Sprintf(" AND state = $%d", len(args))
	}
	if filter.Queue != "" {
		args = append(args, filter.Queue)
		query += fmt.Sprintf(" AND queue = $%d", len(args))
	}
	if filter.Worker != "" {
		args = append(args, filter.Worker)
		query += fmt.Sprintf(" AND worker_id = $%d", len(args))
	}
	if filter.TenantID != "" {
		args = append(args, filter.TenantID)
		query += fmt.Sprintf(" AND tenant_id = $%d", len(args))
	}
	if filter.WorkflowID != "" {
		args = append(args, filter.WorkflowID)
		query += fmt.Sprintf(" AND workflow_id = $%d", len(args))
	}
	query += " ORDER BY created_at DESC"
	limit := filter.Limit
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	args = append(args, limit)
	query += fmt.Sprintf(" LIMIT $%d", len(args))

	rows, err := r.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]domain.Job, 0, limit)
	for rows.Next() {
		job, err := scanJob(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, job)
	}
	return out, rows.Err()
}

func (r *PostgresRepository) GetOverview(ctx context.Context) (domain.JobOverview, error) {
	var overview domain.JobOverview
	err := r.pool.QueryRow(ctx, `
		SELECT
			COUNT(*) AS total_jobs,
			COUNT(*) FILTER (WHERE state = 'queued') AS queued_jobs,
			COUNT(*) FILTER (WHERE state = 'blocked') AS blocked_jobs,
			COUNT(*) FILTER (WHERE state = 'throttled') AS throttled_jobs,
			COUNT(*) FILTER (WHERE state = 'active') AS active_jobs,
			COUNT(*) FILTER (WHERE state = 'failed') AS failed_jobs,
			COUNT(*) FILTER (WHERE state = 'retrying') AS retrying_jobs,
			COUNT(*) FILTER (WHERE state = 'completed') AS completed_jobs,
			COUNT(*) FILTER (WHERE state = 'scheduled') AS scheduled_jobs,
			COUNT(*) FILTER (WHERE state = 'canceled') AS canceled_jobs,
			COALESCE(AVG(execution_ms) FILTER (WHERE state = 'completed'), 0)
		FROM jobs
	`).Scan(
		&overview.TotalJobs,
		&overview.QueuedJobs,
		&overview.BlockedJobs,
		&overview.ThrottledJobs,
		&overview.ActiveJobs,
		&overview.FailedJobs,
		&overview.RetryingJobs,
		&overview.CompletedJobs,
		&overview.ScheduledJobs,
		&overview.CanceledJobs,
		&overview.AverageExecMs,
	)
	if err != nil {
		return domain.JobOverview{}, err
	}
	err = r.pool.QueryRow(ctx, `
		SELECT COUNT(*)
		FROM workers
		WHERE last_seen_at >= now() - interval '20 seconds'
	`).Scan(&overview.ActiveWorkers)
	if err != nil {
		return domain.JobOverview{}, err
	}
	overview.LastUpdatedAt = time.Now().UTC()
	return overview, nil
}

func (r *PostgresRepository) MarkJobQueued(ctx context.Context, job domain.Job) error {
	_, err := r.pool.Exec(ctx, `
		UPDATE jobs
		SET state = $2,
			attempts = $3,
			run_at = $4,
			updated_at = $5,
			started_at = $6,
			finished_at = $7,
			last_error = $8,
			result = $9,
			worker_id = '',
			lease_token = '',
			cancel_requested = $10,
			blocked_reason = $11,
			throttle_until = $12,
			lease_expires_at = $13
		WHERE id = $1
	`, job.ID, string(job.State), job.Attempts, job.RunAt, job.UpdatedAt, job.StartedAt, job.FinishedAt, job.LastError, json.RawMessage(job.Result), job.CancelRequested, job.BlockedReason, job.ThrottleUntil, job.LeaseExpiresAt)
	return err
}

func (r *PostgresRepository) MarkJobActive(ctx context.Context, job domain.Job) error {
	_, err := r.pool.Exec(ctx, `
		UPDATE jobs
		SET state = $2,
			attempts = $3,
			run_at = $4,
			started_at = $5,
			last_heartbeat_at = $6,
			updated_at = $7,
			worker_id = $8,
			lease_token = $9,
			cancel_requested = $10,
			blocked_reason = '',
			throttle_until = NULL,
			lease_expires_at = $11
		WHERE id = $1
	`, job.ID, string(job.State), job.Attempts, job.RunAt, job.StartedAt, job.LastHeartbeatAt, job.UpdatedAt, job.WorkerID, job.LeaseToken, job.CancelRequested, job.LeaseExpiresAt)
	return err
}

func (r *PostgresRepository) MarkJobCompleted(ctx context.Context, job domain.Job) error {
	_, err := r.pool.Exec(ctx, `
		UPDATE jobs
		SET state = $2,
			result = $3,
			finished_at = $4,
			updated_at = $5,
			worker_id = $6,
			lease_token = '',
			execution_ms = $7,
			lease_expires_at = NULL
		WHERE id = $1
	`, job.ID, string(job.State), json.RawMessage(job.Result), job.FinishedAt, job.UpdatedAt, job.WorkerID, job.ExecutionMs)
	return err
}

func (r *PostgresRepository) MarkJobRetrying(ctx context.Context, job domain.Job, retryAt time.Time) error {
	_, err := r.pool.Exec(ctx, `
		UPDATE jobs
		SET state = $2,
			last_error = $3,
			run_at = $4,
			updated_at = $5,
			worker_id = '',
			lease_token = '',
			execution_ms = $6,
			throttle_until = NULL,
			lease_expires_at = NULL
		WHERE id = $1
	`, job.ID, string(job.State), job.LastError, retryAt, job.UpdatedAt, job.ExecutionMs)
	return err
}

func (r *PostgresRepository) MarkJobFailed(ctx context.Context, job domain.Job) error {
	_, err := r.pool.Exec(ctx, `
		UPDATE jobs
		SET state = $2,
			last_error = $3,
			finished_at = $4,
			updated_at = $5,
			worker_id = '',
			lease_token = '',
			execution_ms = $6,
			lease_expires_at = NULL
		WHERE id = $1
	`, job.ID, string(job.State), job.LastError, job.FinishedAt, job.UpdatedAt, job.ExecutionMs)
	return err
}

func (r *PostgresRepository) MarkJobCanceled(ctx context.Context, job domain.Job) error {
	_, err := r.pool.Exec(ctx, `
		UPDATE jobs
		SET state = $2,
			cancel_requested = $3,
			last_error = $4,
			finished_at = $5,
			updated_at = $6,
			lease_expires_at = NULL
		WHERE id = $1
	`, job.ID, string(job.State), job.CancelRequested, job.LastError, job.FinishedAt, job.UpdatedAt)
	return err
}

func (r *PostgresRepository) RecordJobEvent(ctx context.Context, event domain.JobEvent) error {
	_, err := r.pool.Exec(ctx, `
		INSERT INTO job_events (job_id, type, message, metadata, occurred_at)
		VALUES ($1, $2, $3, $4, $5)
	`, event.JobID, event.Type, event.Message, json.RawMessage(event.Metadata), event.OccurredAt)
	return err
}

func (r *PostgresRepository) UpsertWorker(ctx context.Context, worker domain.WorkerStatus) error {
	_, err := r.pool.Exec(ctx, `
		INSERT INTO workers (worker_id, hostname, queues, concurrency, status, started_at, last_seen_at, version)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		ON CONFLICT (worker_id) DO UPDATE
		SET hostname = EXCLUDED.hostname,
			queues = EXCLUDED.queues,
			concurrency = EXCLUDED.concurrency,
			status = EXCLUDED.status,
			last_seen_at = EXCLUDED.last_seen_at,
			version = EXCLUDED.version
	`, worker.WorkerID, worker.Hostname, worker.Queues, worker.Concurrency, worker.Status, worker.StartedAt, worker.LastSeenAt, worker.Version)
	return err
}

func (r *PostgresRepository) ListWorkers(ctx context.Context) ([]domain.WorkerStatus, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT worker_id, hostname, queues, concurrency, status, started_at, last_seen_at, version
		FROM workers
		ORDER BY last_seen_at DESC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	workers := make([]domain.WorkerStatus, 0)
	for rows.Next() {
		var worker domain.WorkerStatus
		if err := rows.Scan(&worker.WorkerID, &worker.Hostname, &worker.Queues, &worker.Concurrency, &worker.Status, &worker.StartedAt, &worker.LastSeenAt, &worker.Version); err != nil {
			return nil, err
		}
		workers = append(workers, worker)
	}
	return workers, rows.Err()
}

func (r *PostgresRepository) UpsertSchedule(ctx context.Context, schedule domain.Schedule) error {
	_, err := r.pool.Exec(ctx, `
		INSERT INTO cron_schedules (
			id, name, cron_expression, queue, type, payload, priority, max_attempts, timeout_seconds,
			enabled, timezone, next_run_at, last_run_at, created_at, updated_at
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
		ON CONFLICT (name) DO UPDATE
		SET cron_expression = EXCLUDED.cron_expression,
			queue = EXCLUDED.queue,
			type = EXCLUDED.type,
			payload = EXCLUDED.payload,
			priority = EXCLUDED.priority,
			max_attempts = EXCLUDED.max_attempts,
			timeout_seconds = EXCLUDED.timeout_seconds,
			enabled = EXCLUDED.enabled,
			timezone = EXCLUDED.timezone,
			next_run_at = EXCLUDED.next_run_at,
			updated_at = EXCLUDED.updated_at
	`, schedule.ID, schedule.Name, schedule.CronExpression, schedule.Queue, schedule.Type, json.RawMessage(schedule.Payload), schedule.Priority, schedule.MaxAttempts, schedule.TimeoutSeconds, schedule.Enabled, schedule.Timezone, schedule.NextRunAt, schedule.LastRunAt, schedule.CreatedAt, schedule.UpdatedAt)
	return err
}

func (r *PostgresRepository) ListSchedules(ctx context.Context) ([]domain.Schedule, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT id, name, cron_expression, queue, type, payload, priority, max_attempts, timeout_seconds,
		       enabled, timezone, next_run_at, last_run_at, created_at, updated_at
		FROM cron_schedules
		ORDER BY name ASC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanSchedules(rows)
}

func (r *PostgresRepository) ListDueSchedules(ctx context.Context, now time.Time) ([]domain.Schedule, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT id, name, cron_expression, queue, type, payload, priority, max_attempts, timeout_seconds,
		       enabled, timezone, next_run_at, last_run_at, created_at, updated_at
		FROM cron_schedules
		WHERE enabled = true AND next_run_at <= $1
		ORDER BY next_run_at ASC
	`, now)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanSchedules(rows)
}

func (r *PostgresRepository) UpdateScheduleRun(ctx context.Context, scheduleID string, ranAt, nextRun time.Time) error {
	_, err := r.pool.Exec(ctx, `
		UPDATE cron_schedules
		SET last_run_at = $2,
			next_run_at = $3,
			updated_at = $2
		WHERE id = $1
	`, scheduleID, ranAt, nextRun)
	return err
}

func scanSchedules(rows pgx.Rows) ([]domain.Schedule, error) {
	schedules := make([]domain.Schedule, 0)
	for rows.Next() {
		var schedule domain.Schedule
		var payload []byte
		if err := rows.Scan(
			&schedule.ID,
			&schedule.Name,
			&schedule.CronExpression,
			&schedule.Queue,
			&schedule.Type,
			&payload,
			&schedule.Priority,
			&schedule.MaxAttempts,
			&schedule.TimeoutSeconds,
			&schedule.Enabled,
			&schedule.Timezone,
			&schedule.NextRunAt,
			&schedule.LastRunAt,
			&schedule.CreatedAt,
			&schedule.UpdatedAt,
		); err != nil {
			return nil, err
		}
		schedule.Payload = payload
		schedules = append(schedules, schedule)
	}
	return schedules, rows.Err()
}

type scannable interface {
	Scan(dest ...interface{}) error
}

func scanJob(row scannable) (domain.Job, error) {
	var job domain.Job
	var payload []byte
	var result []byte
	if err := row.Scan(
		&job.ID,
		&job.Type,
		&job.Queue,
		&job.TenantID,
		&payload,
		&job.Priority,
		&job.State,
		&job.Attempts,
		&job.MaxAttempts,
		&job.SchemaVersion,
		&job.IdempotencyKey,
		&job.WorkflowID,
		&job.ParentJobID,
		&job.DependencyPolicy,
		&job.BlockedReason,
		&job.RunAt,
		&job.CreatedAt,
		&job.UpdatedAt,
		&job.StartedAt,
		&job.FinishedAt,
		&job.LastHeartbeatAt,
		&job.LeaseExpiresAt,
		&job.ThrottleUntil,
		&job.LastError,
		&result,
		&job.WorkerID,
		&job.LeaseToken,
		&job.TimeoutSeconds,
		&job.CancelRequested,
		&job.ExecutionMs,
	); err != nil {
		return domain.Job{}, err
	}
	job.Payload = payload
	job.Result = result
	return job, nil
}
