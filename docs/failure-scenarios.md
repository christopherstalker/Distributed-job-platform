# Failure Scenarios And Recovery

## Worker Crash Mid-Execution

Expected behavior:

- Lease heartbeats stop.
- Redis lease TTL expires.
- Scheduler leader reaps the orphaned lease.
- Job moves to `retrying` or `failed` if attempts are exhausted.
- Attempt history records a lease-expired outcome.

Tradeoff:

- Another worker may safely re-run the job later.
- This is why the system is described as at-least-once, not exactly-once.

## Duplicate Submission

Expected behavior:

- API checks the PostgreSQL idempotency record.
- If the same `tenantId:type:idempotencyKey` is still inside the dedupe window, the original job is returned and no new job is enqueued.
- Dashboard and event stream show duplicate suppression.

Tradeoff:

- A new submission after the dedupe window is treated as a new logical job.

## Dependency Failure

Expected behavior:

- Downstream jobs remain `blocked` by default.
- `blocked_reason` points at the failed upstream state.
- Operators can inspect the dependency graph and replay upstream or downstream work intentionally.

Override:

- Jobs configured with `allow_failed` can continue once all dependencies are terminal.

## Rate Limit Saturation

Expected behavior:

- Worker acquires the lease first, then evaluates limiter policies.
- If a matching policy is saturated, the worker requeues the job as `throttled`.
- Job is moved into the delayed set for the computed retry time.
- Dashboard shows the policy as saturated and the job in the throttled list.

Tradeoff:

- Short bursts can reorder jobs of the same type if some jobs are throttled and others are not.

## Scheduler Leader Loss

Expected behavior:

- Active leader stops renewing its Redis leadership lease.
- Another scheduler acquires the lease after TTL expiration.
- Delayed activation, cron dispatch, and orphan recovery resume from the new leader.

Mitigation for duplicate cron dispatch:

- Scheduler writes a per-schedule dispatch key for the scheduled slot before enqueueing cron work.

## Dead-Letter Replay

Expected behavior:

- Replay removes the job from the DLQ table.
- Queue and payload can be overridden.
- Replay is recorded in the dead-letter audit table.
- The job is re-enqueued with cleared terminal failure state.

Risk:

- Replay can intentionally re-trigger side effects. Use payload edits and idempotency keys carefully.

## PostgreSQL Unavailable

Current behavior:

- API and workers cannot safely persist durable state and will fail requests or state transitions.
- Redis alone is not considered sufficient for authoritative execution history.

Operational note:

- Use PostgreSQL HA or managed backups before production.

## Redis Unavailable

Current behavior:

- Queueing, leases, throttling, and leadership are unavailable.
- Workers cannot dequeue or renew execution.
- Scheduler cannot elect a leader or activate delayed jobs.

Operational note:

- Redis should be deployed with persistence and monitored for latency spikes, not only uptime.
