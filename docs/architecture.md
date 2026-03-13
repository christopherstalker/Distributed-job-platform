# Architecture Overview

## Control Plane

- `api` accepts job submissions, validates payload schemas, creates idempotency records, writes durable metadata, and pushes jobs into Redis.
- `scheduler` instances all run, but only the leader activates delayed work, executes due cron schedules, and reaps orphaned leases.
- `dashboard` reads the aggregated `/api/v1/dashboard` snapshot, per-job timelines, dependency graphs, and live event feed.

## Data Plane

- `worker` instances lease work from Redis, acquire limiter slots, renew leases, execute handlers, and write terminal state back to Redis and PostgreSQL.
- Redis is the hot operational store for:
  - ready queues
  - delayed/scheduled/throttled retry sets
  - lease records and expiry scores
  - rate-limit counters and concurrency sets
  - scheduler leadership
  - pub/sub events
- PostgreSQL is the durable store for:
  - jobs
  - job events
  - job attempts
  - idempotency records
  - dependency edges
  - dead-letter metadata and replay audit
  - worker registry
  - rate-limit policies
  - schedules

## Lease And Recovery Model

```text
worker dequeue
  -> Redis lease hash + expiry score
  -> PostgreSQL job_attempt row
  -> heartbeats renew lease TTL and update last heartbeat
  -> completion/failure clears lease

missed heartbeat
  -> scheduler reaper sees expired score
  -> lease deleted
  -> job moves to retrying or failed/DLQ
  -> PostgreSQL attempt/event rows updated
```

## Idempotency Semantics

- Idempotency scope is `tenantId:type:idempotencyKey`.
- PostgreSQL enforces the durable record for suppression.
- Duplicate submissions inside the dedupe window return the original job instead of creating a new one.
- Final outcomes are attached to the idempotency record for completed and permanently failed jobs.
- This is still at-least-once execution. Suppression applies to duplicate submissions, not arbitrary downstream side effects.

## Dependency Execution Rules

- Jobs with dependencies enter `blocked`.
- Dependency edges are stored in `job_dependencies`.
- A blocked job becomes runnable only when:
  - all dependencies are `completed`, or
  - its policy is `allow_failed` and all dependencies are terminal
- If any dependency fails and the policy is `block`, downstream stays blocked with an explicit `blocked_reason`.

## Rate Limiting Model

- Policies are stored in PostgreSQL and cached by workers.
- Rate policies use Redis sliding-window sorted sets.
- Concurrency policies use Redis sorted sets with lease-aligned expiries.
- Workers evaluate all matching policies before execution:
  - global
  - queue
  - job type
  - tenant
- Denied jobs move to `throttled` and re-enter the delayed set for later eligibility.

## Scheduler Leader Election

- Redis hash key stores the current scheduler leader and lease metadata.
- Active schedulers renew leadership with compare-and-renew semantics.
- If leadership expires, another scheduler acquires the lease and continues delayed activation / cron / orphan recovery.
- Cron dispatch uses a separate Redis dedupe key to reduce duplicate schedule execution during leader handoff windows.

## Job Timeline Model

The event stream records:

- `job.enqueued`
- `job.blocked`
- `job.started`
- `job.heartbeat`
- `job.retrying`
- `job.completed`
- `job.failed`
- `job.recovered`
- `job.unblocked`
- `job.duplicate_suppressed`
- `job.replayed`

## Local Topology

The compose stack runs:

- 1 API
- 2 schedulers
- 2 workers
- 1 Redis
- 1 PostgreSQL
- 1 dashboard
- 1 Prometheus
