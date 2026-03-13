import { memo, useMemo } from "react";

import { AnimatedNumber } from "./AnimatedNumber";
import { HeartbeatPulse, StatusPill } from "./ConsolePrimitives";
import type { DashboardSnapshot, QueueView, SystemEvent, WorkerView } from "../lib/models";
import { formatDateTime, formatLatency, formatRate, formatRelative } from "../lib/safe";

type HeroLiveMeta = {
  health: string;
  transportLabel: string;
  connectionState: string;
  isVisible: boolean;
  lastAttemptAt: string;
  lastSuccessfulAt: string;
  lastMessageAt: string;
  degradedSince?: string;
  degradedReason?: string;
  reconnectAttempt: number;
  currentPollDelayMs: number;
  nextRetryAt?: string;
  hasLiveData?: boolean;
  dataStale?: boolean;
};

export const OperationsHero = memo(function OperationsHero({
  snapshot,
  queueViews,
  workerViews,
  visibleEvents,
  liveMeta,
  leaderHealthy,
  liveStatusDetail,
  globalError,
  onReconnect,
  onRefresh,
}: {
  snapshot: DashboardSnapshot;
  queueViews: QueueView[];
  workerViews: WorkerView[];
  visibleEvents: SystemEvent[];
  liveMeta: HeroLiveMeta;
  leaderHealthy: boolean;
  liveStatusDetail: string;
  globalError?: string;
  onReconnect: () => void;
  onRefresh: () => void;
}) {
  const healthyWorkers = workerViews.filter((worker) => worker.effectiveStatus === "healthy" && worker.heartbeatAgeMs <= 15_000).length;
  const staleWorkers = workerViews.filter((worker) => worker.heartbeatAgeMs > 15_000).length;
  const failedJobs = snapshot.overview.failedJobs;
  const deadLetters = snapshot.deadLetters.length;
  const queuedWork = snapshot.overview.queuedJobs + snapshot.overview.scheduledJobs;
  const delayedWork = snapshot.overview.delayedBacklog;

  const headline = useMemo(() => {
    if (liveMeta.health === "demo") {
      return "Demo sandbox";
    }
    if (liveMeta.health === "offline") {
      return "Transport offline";
    }
    if (liveMeta.health === "reconnecting") {
      return "Recovering stream";
    }
    if (failedJobs > 0 || deadLetters > 0) {
      return "Failure pressure detected";
    }
    if (!leaderHealthy || staleWorkers > 0) {
      return "Coordination needs attention";
    }
    if (liveMeta.health === "degraded") {
      return "Holding a degraded path";
    }
    return "System steady";
  }, [deadLetters, failedJobs, leaderHealthy, liveMeta.health, staleWorkers]);

  const queuePreview = useMemo(
    () => [...queueViews].sort((left, right) => (right.backlog + right.activeJobs) - (left.backlog + left.activeJobs)).slice(0, 3),
    [queueViews],
  );

  const workerPreview = useMemo(
    () =>
      [...workerViews]
        .sort(
          (left, right) =>
            right.heartbeatAgeMs - left.heartbeatAgeMs ||
            right.activeLeaseCount - left.activeLeaseCount,
        )
        .slice(0, 4),
    [workerViews],
  );

  const eventPreview = useMemo(() => visibleEvents.slice(0, 4), [visibleEvents]);
  const lastEvent = eventPreview[0];
  const liveStatusItems = useMemo(
    () => [
      {
        label: "Transport",
        value: liveMeta.transportLabel,
        detail: liveMeta.connectionState,
      },
      {
        label: "Connection",
        value: liveMeta.health,
        detail: liveMeta.isVisible ? "foreground tab" : "background tab",
      },
      {
        label: "Last event",
        value: formatRelative(lastEvent?.timestamp || liveMeta.lastMessageAt),
        detail: lastEvent?.kind || (liveMeta.hasLiveData ? "Awaiting traffic" : "Collecting first sample"),
      },
      {
        label: "Last good snapshot",
        value: formatRelative(liveMeta.lastSuccessfulAt || snapshot.overview.lastUpdatedAt),
        detail: liveMeta.dataStale ? "holding last stable state" : "current view is fresh",
      },
      {
        label: "Reconnects",
        value: `${liveMeta.reconnectAttempt}`,
        detail:
          liveMeta.nextRetryAt
            ? `next ${formatRelative(liveMeta.nextRetryAt)}`
            : liveMeta.reconnectAttempt > 0
              ? "transport settled"
              : "quiet",
      },
      {
        label: "Polling",
        value: liveMeta.currentPollDelayMs > 0 ? formatPollingInterval(liveMeta.currentPollDelayMs) : "paused",
        detail:
          liveMeta.nextRetryAt
            ? `retry ${formatDateTime(liveMeta.nextRetryAt)}`
            : liveMeta.lastAttemptAt
              ? `last probe ${formatRelative(liveMeta.lastAttemptAt)}`
              : "standby",
      },
    ],
    [
      lastEvent,
      liveMeta.connectionState,
      liveMeta.currentPollDelayMs,
      liveMeta.dataStale,
      liveMeta.hasLiveData,
      liveMeta.health,
      liveMeta.isVisible,
      liveMeta.lastAttemptAt,
      liveMeta.lastMessageAt,
      liveMeta.lastSuccessfulAt,
      liveMeta.nextRetryAt,
      liveMeta.reconnectAttempt,
      liveMeta.transportLabel,
      snapshot.overview.lastUpdatedAt,
    ],
  );

  return (
    <section className={`hero-console surface tone-${liveMeta.health}`}>
      <div className="hero-console-grid">
        <div className="hero-console-main">
          <div className="hero-console-head">
            <div className="hero-console-copy">
              <p className="section-eyebrow">Live operations</p>
              <h1>{headline}</h1>
              <p>{liveStatusDetail}</p>
            </div>
            <div className="hero-console-controls">
              <div className="status-inline hero-status-inline">
                <StatusPill pulse={liveMeta.health === "live"} value={liveMeta.health} />
                <StatusPill pulse={["websocket", "sse"].includes(liveMeta.transportLabel.toLowerCase())} value={liveMeta.transportLabel} />
                <StatusPill value={leaderHealthy ? "leader healthy" : "leader stale"} />
              </div>
              <small>
                {liveMeta.degradedSince
                  ? `degraded ${formatRelative(liveMeta.degradedSince)}`
                  : liveMeta.hasLiveData
                    ? `last good snapshot ${formatRelative(liveMeta.lastSuccessfulAt || snapshot.overview.lastUpdatedAt)}`
                    : "waiting for a live snapshot"}
              </small>
            </div>
          </div>

          <div className="hero-stats">
            <div className="hero-stat hero-stat-lead tone-cyan">
              <span>Queued work</span>
              <strong><AnimatedNumber value={queuedWork} /></strong>
              <small>{delayedWork} delayed, {snapshot.overview.activeJobs} active now</small>
            </div>
            <div className="hero-stat tone-emerald">
              <span>Workers</span>
              <strong>
                <AnimatedNumber value={healthyWorkers} />/{snapshot.overview.activeWorkers}
              </strong>
              <small>{staleWorkers} stale heartbeat{staleWorkers === 1 ? "" : "s"}</small>
            </div>
            <div className="hero-stat tone-rose">
              <span>Failure pressure</span>
              <strong><AnimatedNumber value={failedJobs + deadLetters} /></strong>
              <small>{deadLetters} dead-letter item{deadLetters === 1 ? "" : "s"}</small>
            </div>
            <div className="hero-stat tone-amber">
              <span>Throughput</span>
              <strong>{formatRate(snapshot.metrics.jobsPerSecond)}</strong>
              <small>exec p95 {formatLatency(snapshot.metrics.executionLatency.p95Ms)}</small>
            </div>
          </div>

          <div className="hero-operations">
            <section className="hero-band hero-band-flow">
              <div className="hero-band-header">
                <div>
                  <p className="section-eyebrow">Queues</p>
                  <strong>Queue pressure</strong>
                </div>
                <small>{queuedWork} jobs waiting or scheduled</small>
              </div>
              <div className="hero-flow-list">
                {queuePreview.map((queue) => {
                  const total = Math.max(queue.backlog + queue.activeJobs + queue.blocked + queue.deadLetters, 1);
                  const queuedWidth = `${(queue.backlog / total) * 100}%`;
                  const activeWidth = `${(queue.activeJobs / total) * 100}%`;
                  const blockedWidth = `${(queue.blocked / total) * 100}%`;
                  return (
                    <article key={queue.queueName} className="hero-flow-row">
                      <div className="hero-flow-head">
                        <div>
                          <strong>{queue.queueName}</strong>
                          <small>{queue.control?.paused ? "paused intake" : queue.control?.draining ? "draining existing work" : "accepting new work"}</small>
                        </div>
                        <small>{Math.round(queue.saturation)}% saturation</small>
                      </div>
                      <div className="hero-flow-track" aria-hidden="true">
                        <span className="queued" style={{ width: queuedWidth }} />
                        <span className="active" style={{ width: activeWidth }} />
                        <span className="blocked" style={{ width: blockedWidth }} />
                      </div>
                      <div className="hero-flow-meta">
                        <span>{queue.backlog} backlog</span>
                        <span>{queue.activeJobs} active</span>
                        <span>{queue.deadLetters} dead</span>
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>

            <section className="hero-band hero-band-workers">
              <div className="hero-band-header">
                <div>
                  <p className="section-eyebrow">Workers</p>
                  <strong>Worker health</strong>
                </div>
                <small>{staleWorkers > 0 ? `${staleWorkers} workers beyond 15s` : "Heartbeat drift is quiet"}</small>
              </div>
              <div className="hero-worker-list">
                {workerPreview.map((worker) => (
                  <article key={worker.workerId} className="hero-worker-row">
                    <div className="hero-worker-main">
                      <div className="worker-title">
                        <HeartbeatPulse healthy={worker.heartbeatAgeMs <= 15_000} />
                        <strong>{worker.workerId}</strong>
                      </div>
                      <small>{worker.queues.join(", ")}</small>
                    </div>
                    <div className="hero-worker-meta">
                      <strong>{formatLatency(worker.heartbeatAgeMs)}</strong>
                      <small>{worker.activeLeaseCount} leases</small>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          </div>
        </div>

        <aside className="hero-console-side">
          <section className="hero-band hero-band-live">
            <div className="hero-band-header">
              <div>
                <p className="section-eyebrow">Live status</p>
                <strong>Transport</strong>
              </div>
              <small>{liveMeta.hasLiveData ? "steady state retained during refresh" : "waiting for the first snapshot"}</small>
            </div>
            <div className="hero-live-grid">
              {liveStatusItems.map((item) => (
                <article key={item.label} className="hero-live-item">
                  <span>{item.label}</span>
                  <strong>{item.value}</strong>
                  <small>{item.detail}</small>
                </article>
              ))}
            </div>
            <div className="button-row compact hero-live-actions">
              <button className="ghost" type="button" onClick={onReconnect}>
                Reconnect
              </button>
              <button type="button" onClick={onRefresh}>
                Refresh
              </button>
            </div>
            {liveMeta.degradedReason || globalError ? (
              <p className="global-error hero-live-error">
                {globalError || liveMeta.degradedReason}
              </p>
            ) : null}
          </section>

          <section className="hero-band hero-band-events">
            <div className="hero-band-header">
              <div>
                <p className="section-eyebrow">Recent activity</p>
                <strong>Event stream</strong>
              </div>
              <small>{eventPreview.length > 0 ? `${eventPreview.length} latest transitions` : "Healthy and idle"}</small>
            </div>
            {eventPreview.length === 0 ? (
              <p className="muted-copy">Awaiting traffic.</p>
            ) : (
              <div className="hero-timeline">
                {eventPreview.map((event) => (
                  <article key={`${event.timestamp}-${event.kind}-${event.jobId || ""}`} className="hero-timeline-row">
                    <span className="hero-timeline-dot" aria-hidden="true" />
                    <div className="hero-timeline-copy">
                      <div className="hero-timeline-head">
                        <strong>{event.kind}</strong>
                        <small>{formatRelative(event.timestamp)}</small>
                      </div>
                      <p>{event.message || [event.queue, event.workerId, event.state].filter(Boolean).join(" / ")}</p>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        </aside>
      </div>
    </section>
  );
});

function formatPollingInterval(value: number) {
  if (value >= 60_000) {
    return `${Math.round(value / 60_000)}m`;
  }
  return `${Math.round(value / 1_000)}s`;
}
