# Dashboard UI Upgrade

## What was broken

- The dashboard form layer was too brittle around browser autofill and extension-injected mutations.
- The admin token field used a masked search-style input, which was a poor fit for password managers and autofill tooling.
- The frontend relied on a single large component with minimal guardrails, so runtime issues were harder to isolate.
- Most UI controls were informational only: there was no real operator workflow for inspecting jobs deeply or taking corrective action.

## Root cause of the crash

The crash pattern was tied to the form/input layer rather than a backend failure.

- Credential and connection inputs were not explicitly modeled as hardened credential fields.
- Browser autofill/password-manager tooling could inject unexpected values or mutate the DOM around those fields.
- The app also assumed string-like values in several places without a defensive normalization layer.

The fix was not to hide the error, but to harden the whole path:

- safe storage reads/writes
- guarded string normalization before `.trim()`/URL parsing/JSON parsing
- explicit password input handling for the admin token
- global runtime guards for autofill/extension interference
- friendlier error boundary recovery
- inline form validation and non-blocking toast feedback

## What changed

- Added a richer `job inspection` API endpoint returning job, attempts, events, graph, idempotency, and dead-letter context.
- Refactored the frontend into reusable console sections instead of one monolithic page.
- Added a real operational IA with tabs, a side rail, and a premium job detail drawer.
- Introduced demo/live fallback state so the UI stays useful even when live services are unavailable.
- Added queue controls, worker cordon flow, schedule management, DLQ bulk actions, and replay/edit flows.
- Exposed advanced distributed-systems concepts directly in the UI: leases, stale heartbeat risk, idempotency, throttling, blocked workflows, and scheduler leadership health.
- Added motion for live events, drawers, charts, metrics, and skeleton loading states.

## New UI capabilities

- Searchable jobs table with retry, cancel, priority, and detail inspection actions.
- Drawer-based job inspection with payload/result panes, attempts, event timeline, and dependency graph.
- Queue operations for pause/resume/drain with visible saturation and backlog signals.
- Worker operations with heartbeat freshness, lease ownership, concurrency, throughput, and cordon state.
- Schedule creation, pause/resume, and manual trigger controls.
- Dead-letter filtering, bulk replay, bulk delete, and payload override replay.
- Metrics board for throughput, queue latency, execution latency, retry rate, and dead-letter trend.
- Event stream that makes lease recovery and scheduler failover visible instead of hidden backend behavior.

## Stability refactor

The live dashboard architecture was tightened after a render-loop/performance regression showed up under polling failure.

Concrete root causes:

- `useEffectEvent` callbacks were incorrectly included in effect dependency arrays, so polling and inspection subscriptions were recreated on nearly every render.
- Live refresh rebuilt the whole dashboard tree even when API payloads were unchanged because timestamps and sorted collections were regenerated every cycle.
- The drawer was effectively pinned open by auto-selecting the first job whenever selection cleared.
- Repeated failures raised identical warning toasts on each poll and swapped between live/demo state too aggressively.

What changed:

- Added a centralized `useDashboardLiveData` hook for polling, websocket event coalescing, abortable fetches, dedupe, backoff, and health-state tracking.
- Preserved the last successful live snapshot during failures and marked the UI as degraded instead of clearing content.
- Added a persistent live-status banner plus a polling frequency selector and manual refresh path.
- Isolated drawer inspection refresh with cached detail state and inline stale/update indicators.
- Removed aggressive chart/event animation replays and reduced expensive blur/backdrop effects.
- Deduplicated toast emission and kept recovery/error notifications tied to meaningful state transitions only.

## Motion and polish upgrade

The dashboard now uses a shared motion system built on Framer Motion so live updates feel continuous instead of reactive.

What animations were added:

- Metric numbers now interpolate between values instead of snapping.
- Trend charts animate path updates and carry a moving latest-point highlight without replaying from zero.
- Status pills crossfade state changes; live transport badges add a subtle pulse signal.
- Event feeds, blocked-job lists, workflow nodes, schedules, DLQ entries, toasts, and drawer timelines slide/fade into place.
- Tab changes, the connection panel, the status shell, summary panels, and the inspection drawer all use short fade-and-slide transitions.
- Progress bars now animate with `transform: scaleX()` instead of width changes.
- Cards, tiles, rows, and controls now have lift, shadow, border-brightening, press depth, and stronger focus-visible states.

How websocket updates were smoothed:

- Realtime events are coalesced in a short batch window before they enter the UI event feed.
- Snapshot refreshes after event bursts are debounced into a shorter reconciliation window so multiple messages collapse into one calmer update.
- Live snapshot hydration now stabilizes object references for unchanged jobs, workers, trend points, dead-letter entries, and snapshot slices, which limits rerenders to changed data.
- Existing stale-while-revalidate behavior remains in place, so the UI keeps the last good state while transport health recovers.

How performance was preserved:

- Motion is concentrated on `transform` and `opacity`, with layout work limited to scoped list and panel transitions.
- Reusable motion variants keep durations in the 180-320ms range and avoid long-running decorative loops.
- Unchanged data keeps prior references during refresh reconciliation, which reduces React churn during live updates.
- Reduced-motion preferences still collapse animations to near-instant behavior.
