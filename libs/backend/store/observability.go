package store

import (
	"context"
	"fmt"
	"time"

	"distributed-job-system/libs/backend/domain"
)

func (r *PostgresRepository) GetMetricsSummary(ctx context.Context, window time.Duration) (domain.MetricsSummary, error) {
	if window <= 0 {
		window = time.Hour
	}
	since := time.Now().UTC().Add(-window)
	windowSeconds := window.Seconds()
	if windowSeconds <= 0 {
		windowSeconds = 1
	}

	var summary domain.MetricsSummary
	err := r.pool.QueryRow(ctx, `
		WITH window_jobs AS (
			SELECT *
			FROM jobs
			WHERE updated_at >= $1
		),
		window_events AS (
			SELECT type
			FROM job_events
			WHERE occurred_at >= $1
		),
		worker_ages AS (
			SELECT COALESCE(MAX((EXTRACT(EPOCH FROM (now() - last_seen_at)) * 1000)::bigint), 0)::bigint AS max_age_ms
			FROM workers
		)
		SELECT
			COALESCE((SELECT COUNT(*) FILTER (WHERE state = 'completed') FROM window_jobs) / $2, 0),
			COALESCE((SELECT COUNT(*) FILTER (WHERE type = 'job.retrying') FROM window_events) / $2, 0),
			COALESCE((SELECT COUNT(*) FILTER (WHERE type IN ('job.failed', 'job.recovered_failed')) FROM window_events) / $2, 0),
			COALESCE((SELECT percentile_cont(0.50) WITHIN GROUP (ORDER BY execution_ms) FROM window_jobs WHERE execution_ms > 0), 0),
			COALESCE((SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY execution_ms) FROM window_jobs WHERE execution_ms > 0), 0),
			COALESCE((SELECT percentile_cont(0.99) WITHIN GROUP (ORDER BY execution_ms) FROM window_jobs WHERE execution_ms > 0), 0),
			COALESCE((SELECT percentile_cont(0.50) WITHIN GROUP (
				ORDER BY GREATEST(EXTRACT(EPOCH FROM (started_at - run_at)) * 1000, 0)
			) FROM window_jobs WHERE started_at IS NOT NULL), 0),
			COALESCE((SELECT percentile_cont(0.95) WITHIN GROUP (
				ORDER BY GREATEST(EXTRACT(EPOCH FROM (started_at - run_at)) * 1000, 0)
			) FROM window_jobs WHERE started_at IS NOT NULL), 0),
			COALESCE((SELECT percentile_cont(0.99) WITHIN GROUP (
				ORDER BY GREATEST(EXTRACT(EPOCH FROM (started_at - run_at)) * 1000, 0)
			) FROM window_jobs WHERE started_at IS NOT NULL), 0),
			(SELECT max_age_ms FROM worker_ages)
	`, since, windowSeconds).Scan(
		&summary.JobsPerSecond,
		&summary.RetryRate,
		&summary.DeadLetterRate,
		&summary.ExecutionLatency.P50Ms,
		&summary.ExecutionLatency.P95Ms,
		&summary.ExecutionLatency.P99Ms,
		&summary.QueueLatency.P50Ms,
		&summary.QueueLatency.P95Ms,
		&summary.QueueLatency.P99Ms,
		&summary.MaxWorkerHeartbeatAgeMs,
	)
	if err != nil {
		return domain.MetricsSummary{}, err
	}
	return summary, nil
}

func (r *PostgresRepository) GetMetricsTrend(ctx context.Context, bucket, window time.Duration) (domain.MetricsTrend, error) {
	if bucket <= 0 {
		bucket = 5 * time.Minute
	}
	if window <= 0 {
		window = time.Hour
	}
	since := time.Now().UTC().Add(-window)
	bucketSeconds := int(bucket.Seconds())
	if bucketSeconds <= 0 {
		bucketSeconds = 300
	}

	throughput, err := r.seriesFromEvents(ctx, since, bucketSeconds, "job.completed")
	if err != nil {
		return domain.MetricsTrend{}, err
	}
	retryRate, err := r.seriesFromEvents(ctx, since, bucketSeconds, "job.retrying")
	if err != nil {
		return domain.MetricsTrend{}, err
	}
	deadLetterRate, err := r.seriesFromDeadLetterEvents(ctx, since, bucketSeconds)
	if err != nil {
		return domain.MetricsTrend{}, err
	}
	executionP95, err := r.seriesFromJobs(ctx, since, bucketSeconds, "finished_at", "execution_ms")
	if err != nil {
		return domain.MetricsTrend{}, err
	}
	queueLatencyP95, err := r.seriesFromQueueLatency(ctx, since, bucketSeconds)
	if err != nil {
		return domain.MetricsTrend{}, err
	}

	return domain.MetricsTrend{
		Throughput:        throughput,
		ExecutionP95Ms:    executionP95,
		QueueLatencyP95Ms: queueLatencyP95,
		RetryRate:         retryRate,
		DeadLetterRate:    deadLetterRate,
	}, nil
}

func (r *PostgresRepository) GetWorkerLeaseHealth(ctx context.Context) ([]domain.WorkerLeaseHealth, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT
			w.worker_id,
			w.hostname,
			w.status,
			w.queues,
			w.last_seen_at,
			COALESCE((EXTRACT(EPOCH FROM (now() - w.last_seen_at)) * 1000)::bigint, 0)::bigint AS heartbeat_age_ms,
			COALESCE(COUNT(j.id) FILTER (WHERE j.state = 'active'), 0) AS active_lease_count,
			COALESCE(
				MAX((EXTRACT(EPOCH FROM (now() - j.started_at)) * 1000)::bigint)
				FILTER (WHERE j.state = 'active' AND j.started_at IS NOT NULL),
				0
			)::bigint AS oldest_lease_age_ms,
			COALESCE(((ARRAY_AGG(j.id ORDER BY j.started_at ASC) FILTER (WHERE j.state = 'active'))[1])::text, '') AS oldest_lease_job_id,
			w.version,
			w.started_at,
			MAX(j.lease_expires_at) FILTER (WHERE j.state = 'active') AS lease_expires_at
		FROM workers w
		LEFT JOIN jobs j ON j.worker_id = w.worker_id
		GROUP BY w.worker_id, w.hostname, w.status, w.queues, w.last_seen_at, w.version, w.started_at
		ORDER BY w.last_seen_at DESC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var health []domain.WorkerLeaseHealth
	for rows.Next() {
		var item domain.WorkerLeaseHealth
		if err := rows.Scan(
			&item.WorkerID,
			&item.Hostname,
			&item.Status,
			&item.Queues,
			&item.LastSeenAt,
			&item.HeartbeatAgeMs,
			&item.ActiveLeaseCount,
			&item.OldestLeaseAgeMs,
			&item.OldestLeaseJobID,
			&item.Version,
			&item.StartedAt,
			&item.LeaseExpiresAt,
		); err != nil {
			return nil, err
		}
		health = append(health, item)
	}
	return health, rows.Err()
}

func (r *PostgresRepository) seriesFromEvents(ctx context.Context, since time.Time, bucketSeconds int, eventType string) ([]domain.MetricsSeriesPoint, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT
			to_timestamp(floor(EXTRACT(EPOCH FROM occurred_at) / $2) * $2) AT TIME ZONE 'UTC' AS bucket,
			COUNT(*)::float8 / $2 AS value
		FROM job_events
		WHERE occurred_at >= $1 AND type = $3
		GROUP BY bucket
		ORDER BY bucket ASC
	`, since, bucketSeconds, eventType)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanSeries(rows)
}

func (r *PostgresRepository) seriesFromDeadLetterEvents(ctx context.Context, since time.Time, bucketSeconds int) ([]domain.MetricsSeriesPoint, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT
			to_timestamp(floor(EXTRACT(EPOCH FROM occurred_at) / $2) * $2) AT TIME ZONE 'UTC' AS bucket,
			COUNT(*)::float8 / $2 AS value
		FROM job_events
		WHERE occurred_at >= $1 AND type IN ('job.failed', 'job.recovered_failed')
		GROUP BY bucket
		ORDER BY bucket ASC
	`, since, bucketSeconds)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanSeries(rows)
}

func (r *PostgresRepository) seriesFromJobs(ctx context.Context, since time.Time, bucketSeconds int, tsColumn, valueColumn string) ([]domain.MetricsSeriesPoint, error) {
	query := fmt.Sprintf(`
		SELECT
			to_timestamp(floor(EXTRACT(EPOCH FROM %s) / $2) * $2) AT TIME ZONE 'UTC' AS bucket,
			percentile_cont(0.95) WITHIN GROUP (ORDER BY %s)::float8 AS value
		FROM jobs
		WHERE %s >= $1 AND %s > 0
		GROUP BY bucket
		ORDER BY bucket ASC
	`, tsColumn, valueColumn, tsColumn, valueColumn)
	rows, err := r.pool.Query(ctx, query, since, bucketSeconds)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanSeries(rows)
}

func (r *PostgresRepository) seriesFromQueueLatency(ctx context.Context, since time.Time, bucketSeconds int) ([]domain.MetricsSeriesPoint, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT
			to_timestamp(floor(EXTRACT(EPOCH FROM started_at) / $2) * $2) AT TIME ZONE 'UTC' AS bucket,
			percentile_cont(0.95) WITHIN GROUP (
				ORDER BY GREATEST(EXTRACT(EPOCH FROM (started_at - run_at)) * 1000, 0)
			)::float8 AS value
		FROM jobs
		WHERE started_at >= $1
		GROUP BY bucket
		ORDER BY bucket ASC
	`, since, bucketSeconds)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanSeries(rows)
}

func scanSeries(rows interface {
	Next() bool
	Scan(dest ...interface{}) error
	Err() error
}) ([]domain.MetricsSeriesPoint, error) {
	var points []domain.MetricsSeriesPoint
	for rows.Next() {
		var point domain.MetricsSeriesPoint
		if err := rows.Scan(&point.Timestamp, &point.Value); err != nil {
			return nil, err
		}
		points = append(points, point)
	}
	return points, rows.Err()
}
