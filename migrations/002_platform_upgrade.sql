ALTER TABLE jobs
    ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'default',
    ADD COLUMN IF NOT EXISTS schema_version integer NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS idempotency_key text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS workflow_id text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS parent_job_id text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS dependency_policy text NOT NULL DEFAULT 'block',
    ADD COLUMN IF NOT EXISTS blocked_reason text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS throttle_until timestamptz,
    ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_jobs_tenant_state_created_at ON jobs (tenant_id, state, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_workflow_id ON jobs (workflow_id) WHERE workflow_id <> '';
CREATE INDEX IF NOT EXISTS idx_jobs_idempotency_key ON jobs (tenant_id, type, idempotency_key) WHERE idempotency_key <> '';
CREATE INDEX IF NOT EXISTS idx_jobs_state_throttle_until ON jobs (state, throttle_until);

CREATE TABLE IF NOT EXISTS job_dependencies (
    job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    depends_on_job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (job_id, depends_on_job_id)
);

CREATE INDEX IF NOT EXISTS idx_job_dependencies_depends_on ON job_dependencies (depends_on_job_id, job_id);

CREATE TABLE IF NOT EXISTS job_attempts (
    id bigserial PRIMARY KEY,
    job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    attempt integer NOT NULL,
    worker_id text NOT NULL DEFAULT '',
    lease_token text NOT NULL DEFAULT '',
    status text NOT NULL,
    error_type text NOT NULL DEFAULT '',
    error_message text NOT NULL DEFAULT '',
    stack_trace text NOT NULL DEFAULT '',
    lease_expired boolean NOT NULL DEFAULT false,
    started_at timestamptz NOT NULL,
    finished_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (job_id, attempt)
);

CREATE INDEX IF NOT EXISTS idx_job_attempts_job_id_attempt ON job_attempts (job_id, attempt DESC);

CREATE TABLE IF NOT EXISTS dead_letters (
    job_id uuid PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
    queue text NOT NULL,
    worker_id text NOT NULL DEFAULT '',
    error_type text NOT NULL DEFAULT '',
    error_message text NOT NULL DEFAULT '',
    stack_trace text NOT NULL DEFAULT '',
    failed_at timestamptz NOT NULL,
    last_attempt integer NOT NULL,
    replay_count integer NOT NULL DEFAULT 0,
    last_replayed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_dead_letters_queue_failed_at ON dead_letters (queue, failed_at DESC);
CREATE INDEX IF NOT EXISTS idx_dead_letters_error_type_failed_at ON dead_letters (error_type, failed_at DESC);

CREATE TABLE IF NOT EXISTS dead_letter_actions (
    id bigserial PRIMARY KEY,
    job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    action text NOT NULL,
    actor text NOT NULL DEFAULT 'system',
    from_queue text NOT NULL DEFAULT '',
    to_queue text NOT NULL DEFAULT '',
    payload_before jsonb,
    payload_after jsonb,
    occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dead_letter_actions_job_id_occurred_at ON dead_letter_actions (job_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS idempotency_records (
    scope text PRIMARY KEY,
    tenant_id text NOT NULL,
    job_type text NOT NULL,
    idempotency_key text NOT NULL,
    job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    status text NOT NULL DEFAULT 'accepted',
    outcome jsonb,
    first_seen_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_idempotency_records_expires_at ON idempotency_records (expires_at);
CREATE INDEX IF NOT EXISTS idx_idempotency_records_job_id ON idempotency_records (job_id);

CREATE TABLE IF NOT EXISTS rate_limit_policies (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL UNIQUE,
    scope text NOT NULL,
    scope_value text NOT NULL DEFAULT '',
    mode text NOT NULL,
    limit_value integer NOT NULL,
    window_seconds integer NOT NULL DEFAULT 60,
    burst integer NOT NULL DEFAULT 0,
    enabled boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_policies_enabled_scope ON rate_limit_policies (enabled, scope, scope_value);

INSERT INTO rate_limit_policies (name, scope, scope_value, mode, limit_value, window_seconds, burst, enabled)
VALUES
    ('global-rate', 'global', '', 'rate', 500, 1, 0, true),
    ('email-send-rate', 'job_type', 'email.send', 'rate', 50, 1, 0, true),
    ('invoice-sync-concurrency', 'job_type', 'invoice.sync', 'concurrency', 5, 30, 0, true),
    ('tenant-a-rate', 'tenant', 'tenant-a', 'rate', 100, 60, 0, true)
ON CONFLICT (name) DO NOTHING;
