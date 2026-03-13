# Distributed Job Processing System

Production-grade distributed job platform built in Go, Redis, PostgreSQL, and React. The system keeps Redis on the hot path for leases, queues, throttling, and scheduler leadership while PostgreSQL holds the durable audit trail, workflow graph, DLQ metadata, and idempotency records.

## What Changed

The platform now includes:

- Lease-based execution with worker-owned Redis leases, lease renewal heartbeats, and orphan recovery.
- Honest at-least-once delivery with PostgreSQL-backed idempotency records and duplicate suppression.
- DAG workflows with dependency-blocked jobs, fan-out and fan-in execution, and a seeded thumbnail workflow.
- Redis-backed rate limiting and concurrency control for queues, job types, tenants, and global policy.
- Dead-letter persistence with replay, payload edit, queue move, bulk replay, and audit entries.
- Redis leader election for active/passive schedulers with cron dispatch dedupe guards.
- Prometheus metrics, per-job timelines, throughput and latency trends, worker lease health, and live dashboard updates.
- A redesigned ops console with hardened forms, queue controls, worker maintenance flows, rich job inspection drawers, and live/demo fallback behavior.
- A final production polish pass across the dashboard shell, motion system, realtime refresh behavior, and deploy handoff documentation.

## Architecture

```text
                        +----------------------+
                        |      Dashboard       |
                        |  ops console / WS    |
                        +----------+-----------+
                                   |
                                   v
+---------+     HTTP/JSON     +----+----+      Pub/Sub      +-----------+
| Clients  +------------------>   API   +<------------------+   Redis   |
+---------+                   +----+----+                   +-----+-----+
                                   |                              |
                                   |                              |
                                   v                              v
                             +-----+------+                +------+------+
                             | PostgreSQL |                |   Workers   |
                             | durable    |<-------------->+ leases, HB  |
                             | state/audit|                | processors   |
                             +-----+------+                +------+------+
                                   ^                              |
                                   |                              |
                                   +------------------------------+
                                                  ^
                                                  |
                                           +------+------+
                                           | Scheduler(s)|
                                           | leader elect |
                                           +-------------+
```

More detail:

- [Architecture and execution model](docs/architecture.md)
- [Failure scenarios and recovery notes](docs/failure-scenarios.md)

## Service Boundaries

- `api/`: job submission, replay/cancel controls, dashboard snapshot APIs, timelines, dependency graph APIs, WebSocket fan-out, and `/metrics`.
- `worker/`: dequeue, lease renewals, limiter acquisition, handler execution, attempt tracking, dependency unlock, and DLQ transitions.
- `scheduler/`: delayed activation, orphan reaping, cron dispatch, and Redis leader election.
- `dashboard/`: React/Vite operator console for queue health, throttles, leases, DLQ replay, and workflow inspection.
- `libs/backend/`: shared domain, queue broker, schema validation, leadership, rate limits, metrics, worker runtime, scheduler coordination, and persistence.

## Dashboard UI

The dashboard is now an operator console rather than a static status page.

- Top-level operating model: environment selector, live mode toggle, connection status, search/command bar, summary strip, and tabbed console sections.
- Real operator workflows: submit jobs, retry/cancel jobs, replay failed work with edited payloads, inspect attempts, pause/drain queues, cordon workers, manage schedules, and bulk-operate on dead letters.
- Visible distributed-systems surfaces: lease ownership, heartbeat freshness, stale lease risk, idempotency context, throttling saturation, dependency-blocked jobs, and scheduler leadership health.
- Resilience hardening: guarded storage/input logic, safer credential handling for the admin token, autofill/extension runtime protection, inline validation, toast feedback, and an improved error boundary.

Implementation notes:

- [Dashboard UI upgrade notes](docs/dashboard-ui-upgrade.md)
- [Engineering hardening note](docs/engineering-hardening-note.md)

### Final polish pass

- Visual/design: a calmer command deck, a dominant live-status hero, more editorial overview composition, quieter empty states, and reduced card-grid repetition.
- Motion: interpolated metric values, smoother tab/panel transitions, steadier live-stream updates, and consistent hover/press feedback across controls.
- Performance: quieter background refreshes, fewer high-frequency layout animations, imperative number interpolation to avoid React rerenders per frame, and better separation between live widgets and static layout.
- Remaining limitations: queue administration, worker maintenance, and job priority mutations remain demo-only in live mode until the backend exposes real control-plane endpoints.

### Dashboard stability notes

The live dashboard was refactored to remove the main transport and rendering failure paths.

What was broken:

- The console could silently rewrite the operator-configured API base URL after repeated failures, which turned a transient outage into a configuration mutation.
- Base URL normalization dropped path prefixes, so non-root API deployments could build the wrong REST and websocket URLs even when the host was correct.
- The frontend had only websocket plus polling behavior, not a real websocket -> SSE -> polling ladder.
- Request handling treated empty or malformed responses too loosely and had no timeout classification, so `ERR_EMPTY_RESPONSE` and aborted responses degraded into noisy generic failures.
- Browser-extension/autofill runtime noise was "handled" by generating more warning toasts, which made the dashboard feel less stable instead of calmer.
- The main polling effect depended on `lastSuccessfulAt`, so every successful refresh immediately restarted the effect and could collapse polling into a near-continuous refetch loop.
- The API applied a 30-second request timeout to SSE and websocket routes along with normal JSON routes, which is fine for REST but wrong for long-lived transports.
- Live-mode actions could silently fall back to local demo mutations when live data was unavailable, which made the dashboard look interactive while bypassing the backend entirely.
- The autofill/extension error filter matched generic `null` and `.includes` crashes, which could hide real app-caused failures instead of isolating only extension noise.

The live refresh model is now:

- one orchestrated live-data hook plus a transport manager for websocket, SSE, polling fallback, reconnect backoff, and later realtime probes
- typed request parsing with timeout handling, empty-body guards, auth/server/network classification, and shared request dedupe
- visibility-aware polling that pauses in hidden tabs and slows automatically when realtime transport is degraded
- stale-while-revalidate behavior that keeps the last successful data on screen instead of wiping the console on transient failure, while showing an honest empty live state before the first sync
- websocket -> SSE -> polling downgrade behavior with explicit transport status: `Live (WebSocket)`, `Live (SSE)`, `Polling`, `Degraded`, `Offline`, and `Demo`
- a single top-level status banner plus diagnostics for transport mode, connection state, reconnect attempts, last message/fetch time, retry timing, and polling interval
- isolated drawer refresh with cached inspection data and inline stale state instead of warning-toast spam
- live-mode write actions always target the backend; the dashboard no longer fabricates demo mutations while live mode is selected
- queue pause/drain, worker cordon, and priority changes are explicitly disabled in live mode because the backend does not implement those endpoints yet

Degraded mode behavior:

- the last known good snapshot remains visible
- data is marked stale via the connection banner and "last updated" timing instead of clearing panels
- polling stays active at a controlled interval while realtime probes back off with jitter
- the operator can manually reconnect without forcing a page remount

Remaining limitations:

- Queue administration, worker maintenance, and priority mutation remain demo-only until the API exposes real control-plane endpoints, so those buttons are intentionally disabled in live mode.
- The dashboard can isolate known extension/autofill noise, but extension-injected DOM or network mutations can still affect the browser session; the app now treats them as noise rather than app faults when the signatures are explicit.

## Core Semantics

### Delivery guarantee

- The platform provides at-least-once execution.
- It does not claim exactly-once delivery.
- Idempotency keys reduce duplicate side effects by suppressing duplicate submissions and persisting final outcomes for the same logical job key.

### Job state machine

```text
queued -> active -> completed
queued -> active -> retrying -> queued
queued -> active -> failed (dead-lettered)
queued -> blocked -> queued
queued -> throttled -> queued
scheduled -> queued
active -> retrying / failed / canceled
```

### Lease model

- `Dequeue` acquires a worker-owned Redis lease with TTL.
- Workers renew leases on a heartbeat interval.
- Scheduler instances scan lease-expiry scores and recover orphaned work.
- Recovery either moves work back to retrying or dead-letters it when attempts are exhausted.

## Demo Workflow

The dashboard and API can seed a real workflow:

```text
file.ingest
   |
   +--> image.thumbnail (sm)
   +--> image.thumbnail (md)
   +--> image.thumbnail (lg)
                |
         metadata.aggregate
                |
           user.notify
```

Seed it from the dashboard or:

```bash
curl -X POST http://localhost:8080/api/v1/workflows/demo/thumbnail \
  -H "Authorization: Bearer dev-admin-token" \
  -H "Content-Type: application/json" \
  -d '{"tenantId":"tenant-a"}'
```

## Local Run

### Docker Compose

```bash
docker compose up --build
```

Default endpoints:

- API: `http://localhost:8080`
- Dashboard: `http://localhost:3000`
- Scheduler metrics: `http://localhost:8090/metrics`
- Standby scheduler metrics: `http://localhost:8091/metrics`
- Worker metrics: `http://localhost:8081/metrics`, `http://localhost:8082/metrics`
- Prometheus: `http://localhost:9090`
- PostgreSQL: `localhost:55432`

Default operator token: `dev-admin-token`

### Manual services

The repo defaults now target the compose-managed PostgreSQL port (`localhost:55432`) so manual `go run` works against the repo's Docker services without extra overrides.

If you want to reuse only PostgreSQL and Redis from Docker:

```bash
docker compose up -d postgres redis
```

```bash
go run ./api
HTTP_ADDR=:8090 SCHEDULER_ID=scheduler-a go run ./scheduler
HTTP_ADDR=:8091 SCHEDULER_ID=scheduler-b go run ./scheduler
HTTP_ADDR=:8081 WORKER_ID=worker-a WORKER_CONCURRENCY=32 go run ./worker
HTTP_ADDR=:8082 WORKER_ID=worker-b WORKER_CONCURRENCY=32 go run ./worker
npm install && npm run dev
```

If you already run PostgreSQL on `localhost:5432`, override `POSTGRES_URL` before starting the Go services.

### Dashboard only

```bash
npm install
npm run dev
```

Optional dashboard env vars:

- `VITE_API_BASE_URL` or `NEXT_PUBLIC_API_URL`: default API origin for the console, for example `http://localhost:8080`
- `VITE_WS_BASE_URL` or `NEXT_PUBLIC_WS_URL`: optional realtime origin override when websocket/SSE are hosted separately from the API base URL
- `VITE_ADMIN_TOKEN` or `NEXT_PUBLIC_ADMIN_TOKEN`: default operator token shown in the connection panel

## Key API Endpoints

- `POST /api/v1/jobs`: enqueue with optional `idempotencyKey`, `tenantId`, `schemaVersion`, and `dependencies`.
- `GET /api/v1/dashboard`: ops snapshot for throughput, latency, leader health, DLQ, blocked jobs, throttled jobs, and worker lease state.
- `GET /ws/events`: authenticated websocket event stream for live job/platform events.
- `GET /sse/events`: authenticated server-sent event stream used as the first fallback when websocket upgrades fail.
- `GET /api/v1/jobs/{jobID}/events`: per-job event timeline.
- `GET /api/v1/jobs/{jobID}/graph`: dependency graph for the selected job or workflow node.
- `GET /api/v1/jobs/{jobID}/inspection`: enriched inspection payload for drawer-based job details, attempts, idempotency, and DLQ context.
- `GET /api/v1/dlq`: dead-letter listing with failure metadata.
- `POST /api/v1/dlq/replay`: bulk replay with queue and payload overrides.
- `POST /api/v1/dlq/delete`: bulk delete dead-letter metadata.
- `GET /api/v1/rate-limits`: active rate/concurrency policies.

Example enqueue with idempotency:

```bash
curl -X POST http://localhost:8080/api/v1/jobs \
  -H "Authorization: Bearer dev-admin-token" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "email.send",
    "queue": "critical",
    "tenantId": "tenant-a",
    "schemaVersion": 1,
    "idempotencyKey": "welcome-email:42",
    "payload": {
      "recipient": "ops@example.com",
      "durationMs": 250
    }
  }'
```

## Built-in Processors

- `email.send`
- `report.generate`
- `cleanup.run`
- `webhook.dispatch`
- `file.ingest`
- `image.thumbnail`
- `metadata.aggregate`
- `user.notify`

## Testing

Backend:

```bash
go test ./...
```

Dashboard:

```bash
npm install
npm test
npm run build
```

The Go suite includes integration coverage for lease expiration recovery, duplicate suppression, dependency unlock, rate-limit enforcement, leader failover, DLQ replay, and metrics/event emission.

## Deployment Handoff

### Production build

```bash
go test ./...
go build ./api ./scheduler ./worker

npm ci
npm test
npm run build
```

- The dashboard build output is `dist/`.
- Use the provided Dockerfiles if you want a containerized build path instead of local binaries.

### Vercel (dashboard-only deployment)

This repository is a multi-service system:

- `api` is a standalone Go HTTP server.
- `worker` is a standalone Go worker process.
- `scheduler` is a standalone Go scheduler/leader process.
- the dashboard frontend is the Vite app in this repository root.

Only the dashboard frontend should be deployed to Vercel. Backend services must run outside Vercel (for example on containers/VMs/Kubernetes) with Redis and PostgreSQL available.

Vercel configuration in this repo is intentionally frontend-only:

- `vercel.json` builds only the Vite dashboard (`npm ci && npm run build`, output `dist/`).
- `.vercelignore` excludes backend/service directories (`api/`, `scheduler/`, `worker/`, `libs/backend/`, etc.) so Vercel does **not** interpret `api/main.go` as a Vercel function.

Recommended Vercel project settings:

- Root Directory: repository root (`.`).
- Framework Preset: Vite.
- Build Command: `npm run build`
- Output Directory: `dist`

If your hosting platform supports setting a project root directory and currently tries to run `go build` from `/app`, set the project root to the frontend package directory (this repository root). Do **not** point it at Go service directories for the dashboard deployment.

Dashboard-to-API connectivity on Vercel:

- Set `VITE_API_BASE_URL` (or `NEXT_PUBLIC_API_URL`) to the externally reachable API origin (for example `https://jobs-api.example.com`).
- If realtime transport is hosted on a different origin, set `VITE_WS_BASE_URL` (or `NEXT_PUBLIC_WS_URL`).
- Set `VITE_ADMIN_TOKEN` (or `NEXT_PUBLIC_ADMIN_TOKEN`) in Vercel environment variables as needed for operator auth UX.
- Ensure the API service allows the dashboard origin via `DASHBOARD_ORIGIN`.

Do not deploy `api`, `worker`, or `scheduler` as Vercel functions; they rely on long-running service behavior and shared Redis/PostgreSQL state.

### Non-Vercel buildpack platforms (Railway/Render/Nixpacks-style)

Some platforms auto-detect Go when `go.mod` exists and may run `go build` in `/app`, which fails for frontend-only deploys with `no Go files in /app`.

This repo includes `nixpacks.toml` to force Node/Vite build detection for dashboard deployments:

- install: `npm ci`
- build: `npm run build`
- start: `npm run preview -- --host 0.0.0.0 --port $PORT`

For dashboard-only deployment on these platforms, keep the service root at repository root (`.`) and do not configure Go as the runtime.

### Required environment variables

Backend:

- `POSTGRES_URL`: required durable store connection string
- `REDIS_ADDR`: Redis endpoint for leases, queues, rate limits, and leadership
- `ADMIN_TOKEN`: bearer token required by the dashboard and write endpoints
- `DASHBOARD_ORIGIN`: allowed dashboard origin for browser access and transport setup

Operationally common overrides:

- `HTTP_ADDR`
- `AUTO_MIGRATE`
- `SCHEDULER_ID`
- `WORKER_ID`
- `WORKER_CONCURRENCY`
- `WORKER_QUEUES`
- `SERVICE_VERSION`

Dashboard:

- `VITE_API_BASE_URL` or `NEXT_PUBLIC_API_URL`
- `VITE_WS_BASE_URL` or `NEXT_PUBLIC_WS_URL` (optional realtime override)
- `VITE_ADMIN_TOKEN` or `NEXT_PUBLIC_ADMIN_TOKEN`

### Transport behavior

- The dashboard prefers `WebSocket`, falls back to `SSE`, and then falls back to polling.
- Hidden tabs pause the active live transport and stop active polling until the tab becomes visible again.
- Manual reconnect is safe and does not remount the app; it retries the transport ladder and keeps the current console state visible.

### Degraded mode behavior

- The last known good snapshot stays on screen.
- Status copy and timestamps mark the view as stale instead of clearing panels.
- Background polling continues on a controlled interval while realtime probes back off.
- Live-mode write actions still target the backend; the console does not silently switch to demo mutations.

### Demo-only controls

- Queue pause, resume, and drain
- Worker cordon and resume
- Job priority adjustment

These controls remain visible for product completeness, but they are intentionally disabled in live mode until the API exposes real control-plane endpoints.

### Deployment checklist

- Confirm `POSTGRES_URL`, `REDIS_ADDR`, `ADMIN_TOKEN`, and `DASHBOARD_ORIGIN` are set for the target environment.
- Verify the dashboard can reach the API origin configured by `VITE_API_BASE_URL`.
- Run `go test ./...`.
- Run `npm test && npm run build`.
- Confirm reverse proxies do not apply short request timeouts to `/ws/events` or `/sse/events`.
- Verify the console still loads cleanly when realtime transport is unavailable and when data is sparse.
- Verify demo-only controls are visibly disabled in live mode.
- Confirm metrics and logs are scraped from the API, scheduler, and worker processes.

### Known limitations before deployment

- Queue administration, worker maintenance, and priority mutation are still demo-only in live mode.
- Browser extensions can still interfere with the operator session even though the console filters the known autofill/runtime noise signatures.

## Production Hardening Notes

- Redis remains a critical dependency for leases, rate limits, and scheduler leadership. Run it with persistence and failure-domain isolation.
- PostgreSQL is the durable source of truth for idempotency, attempts, dependency edges, and dead-letter metadata. Back it up accordingly.
- The dashboard is an operator surface, not an authorization model. Put the API behind real auth in production.
- High-cardinality Prometheus labels were avoided except for worker heartbeat age; review that choice if worker counts become very large.
- Event and attempt retention are durable by design; add archival or pruning policies before large-scale production retention windows.
