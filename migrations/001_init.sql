CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS jobs (
    id uuid PRIMARY KEY,
    type text NOT NULL,
    queue text NOT NULL,
    payload jsonb NOT NULL,
    priority integer NOT NULL DEFAULT 5,
    state text NOT NULL,
    attempts integer NOT NULL DEFAULT 0,
    max_attempts integer NOT NULL DEFAULT 5,
    run_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    finished_at timestamptz,
    last_heartbeat_at timestamptz,
    last_error text NOT NULL DEFAULT '',
    result jsonb,
    worker_id text NOT NULL DEFAULT '',
    lease_token text NOT NULL DEFAULT '',
    timeout_seconds integer NOT NULL DEFAULT 0,
    cancel_requested boolean NOT NULL DEFAULT false,
    execution_ms bigint NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_jobs_state_created_at ON jobs (state, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_queue_state_created_at ON jobs (queue, state, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_run_at_state ON jobs (run_at, state);
CREATE INDEX IF NOT EXISTS idx_jobs_worker_id ON jobs (worker_id);

CREATE TABLE IF NOT EXISTS job_events (
    id bigserial PRIMARY KEY,
    job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    type text NOT NULL,
    message text NOT NULL,
    metadata jsonb,
    occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_job_events_job_id_occurred_at ON job_events (job_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS workers (
    worker_id text PRIMARY KEY,
    hostname text NOT NULL,
    queues text[] NOT NULL,
    concurrency integer NOT NULL,
    status text NOT NULL,
    started_at timestamptz NOT NULL,
    last_seen_at timestamptz NOT NULL,
    version text NOT NULL DEFAULT 'dev'
);

CREATE INDEX IF NOT EXISTS idx_workers_last_seen_at ON workers (last_seen_at DESC);

CREATE TABLE IF NOT EXISTS cron_schedules (
    id uuid PRIMARY KEY,
    name text NOT NULL UNIQUE,
    cron_expression text NOT NULL,
    queue text NOT NULL,
    type text NOT NULL,
    payload jsonb NOT NULL,
    priority integer NOT NULL DEFAULT 5,
    max_attempts integer NOT NULL DEFAULT 5,
    timeout_seconds integer NOT NULL DEFAULT 0,
    enabled boolean NOT NULL DEFAULT true,
    timezone text NOT NULL DEFAULT 'UTC',
    next_run_at timestamptz NOT NULL,
    last_run_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cron_schedules_next_run_at ON cron_schedules (enabled, next_run_at);
