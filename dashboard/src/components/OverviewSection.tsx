import { memo } from "react";

import { AnimatePresence, motion } from "framer-motion";

import { EmptyState, MetricTile, ProgressBar, SectionHeader, StatusPill } from "./ConsolePrimitives";
import { TrendChart } from "./TrendChart";
import { FADE_SLIDE, FAST_TRANSITION, LAYOUT_SPRING, getStaggerDelay } from "../lib/motion";
import type { DashboardSnapshot, Job, QueueView, SystemEvent } from "../lib/models";
import { formatDateTime, formatLatency, formatRate, formatRelative } from "../lib/safe";

export const OverviewSection = memo(function OverviewSection({
  snapshot,
  queueViews,
  visibleEvents,
  blockedJobs,
  leaderHealthy,
  queueControlsEnabled,
  queueControlHint,
  onQueueControl,
  onSelectJob,
}: {
  snapshot: DashboardSnapshot;
  queueViews: QueueView[];
  visibleEvents: SystemEvent[];
  blockedJobs: Job[];
  leaderHealthy: boolean;
  queueControlsEnabled: boolean;
  queueControlHint?: string;
  onQueueControl: (queueName: string, action: "pause" | "resume" | "drain") => void;
  onSelectJob: (jobId: string) => void;
}) {
  const queuedWork = snapshot.overview.queuedJobs + snapshot.overview.scheduledJobs;
  const staleWorkers = snapshot.workers.filter((worker) => worker.heartbeatAgeMs > 15_000).length;
  const recoveredEvents = visibleEvents.filter((event) => event.kind.includes("recovered")).length;

  return (
    <>
      <section className="surface overview-performance-panel">
        <SectionHeader
          eyebrow="Overview"
          title="Platform signals"
          detail="The operating picture that matters first."
          action={<small>Last refresh {formatRelative(snapshot.overview.lastUpdatedAt)}</small>}
        />
        <div className="chart-grid overview-chart-grid">
          <TrendChart
            title="Throughput"
            numericValue={snapshot.metrics.jobsPerSecond}
            series={snapshot.trend.throughput}
            tone="cyan"
            detail={`p95 exec ${formatLatency(snapshot.metrics.executionLatency.p95Ms)}`}
            valueFormatter={formatRate}
          />
          <TrendChart
            title="Queue delay"
            numericValue={snapshot.metrics.queueLatency.p95Ms}
            series={snapshot.trend.queueLatencyP95Ms}
            tone="amber"
            detail={`p99 ${formatLatency(snapshot.metrics.queueLatency.p99Ms)}`}
            valueFormatter={formatLatency}
          />
          <TrendChart
            title="DLQ drift"
            numericValue={snapshot.metrics.deadLetterRate}
            series={snapshot.trend.deadLetterRate}
            tone="rose"
            detail={`${snapshot.deadLetters.length} jobs in DLQ`}
            valueFormatter={formatRate}
          />
        </div>
        <div className="metric-strip overview-metric-strip overview-signal-strip">
          <MetricTile
            className="overview-signal-lead"
            label="Queued work"
            numericValue={queuedWork}
            detail={`${snapshot.overview.activeJobs} active / ${snapshot.overview.delayedBacklog} delayed`}
            tone={queuedWork > 0 ? "cyan" : "emerald"}
            size="feature"
          />
          <MetricTile
            label="Retry pressure"
            numericValue={snapshot.metrics.retryRate}
            detail={snapshot.metrics.retryRate > 1.5 ? "elevated" : "stable"}
            tone={snapshot.metrics.retryRate > 1.5 ? "amber" : "emerald"}
            valueFormatter={formatRate}
          />
          <MetricTile
            label="Exec p95"
            numericValue={snapshot.metrics.executionLatency.p95Ms}
            detail={`queue ${formatLatency(snapshot.metrics.queueLatency.p95Ms)}`}
            tone="amber"
            valueFormatter={formatLatency}
          />
          <MetricTile
            label="Heartbeat age"
            numericValue={snapshot.metrics.maxWorkerHeartbeatAgeMs}
            detail={staleWorkers > 0 ? `${staleWorkers} workers drifted` : "heartbeat drift is quiet"}
            tone={staleWorkers > 0 ? "rose" : "emerald"}
            valueFormatter={formatLatency}
          />
        </div>
      </section>

      <section className="overview-operations-grid">
        <article className="surface overview-queue-panel">
          <SectionHeader
            eyebrow="Operations"
            title="Queue posture"
            detail="The queues carrying the most operational weight."
          />
          {queueControlHint ? <p className="capability-note">{queueControlHint}</p> : null}
          <div className="queue-ops-table">
            {queueViews.map((queue, index) => (
              <motion.article
                key={queue.queueName}
                animate={FADE_SLIDE.animate}
                className="queue-ops-row"
                exit={FADE_SLIDE.exit}
                initial={FADE_SLIDE.initial}
                transition={{ ...LAYOUT_SPRING, delay: getStaggerDelay(index, 0.02) }}
              >
                <header className="queue-ops-head">
                  <div>
                    <strong>{queue.queueName}</strong>
                    <small>{queue.control?.paused ? "paused intake" : queue.control?.draining ? "draining existing work" : "accepting new work"}</small>
                  </div>
                  <StatusPill value={queue.control?.paused ? "paused" : queue.control?.draining ? "draining" : "healthy"} />
                </header>
                <div className="queue-ops-metrics">
                  <MetricTile label="Backlog" numericValue={queue.backlog} size="compact" />
                  <MetricTile label="Active" numericValue={queue.activeJobs} size="compact" />
                  <MetricTile label="Blocked" numericValue={queue.blocked} size="compact" />
                  <MetricTile label="Dead" numericValue={queue.deadLetters} size="compact" />
                </div>
                <ProgressBar value={queue.saturation} label="saturation" />
                <div className="button-row queue-ops-actions">
                  <button className="ghost" type="button" disabled={!queueControlsEnabled} onClick={() => onQueueControl(queue.queueName, "pause")}>
                    Pause
                  </button>
                  <button className="ghost" type="button" disabled={!queueControlsEnabled} onClick={() => onQueueControl(queue.queueName, "resume")}>
                    Resume
                  </button>
                  <button type="button" disabled={!queueControlsEnabled} onClick={() => onQueueControl(queue.queueName, "drain")}>
                    Drain
                  </button>
                </div>
              </motion.article>
            ))}
          </div>
        </article>

        <div className="overview-side-stack">
          <article className="surface overview-coordination-panel">
            <SectionHeader
              eyebrow="Coordination"
              title="Control plane"
              detail="Leader lease, heartbeat drift, and recovery signals."
            />
            <div className="signal-list">
              <article className="signal-row">
                <div>
                  <strong>Leader lease</strong>
                  <p>{snapshot.leader.schedulerId || "No active leader announced"}</p>
                </div>
                <div className="row-end">
                  <StatusPill value={leaderHealthy ? "leader healthy" : "leader stale"} />
                  <small>{snapshot.leader.leaseExpiresAt ? formatRelative(snapshot.leader.leaseExpiresAt) : "lease unknown"}</small>
                </div>
              </article>
              <article className="signal-row">
                <div>
                  <strong>Heartbeat drift</strong>
                  <p>{staleWorkers} workers beyond 15s</p>
                </div>
                <div className="row-end">
                  <StatusPill value={snapshot.metrics.maxWorkerHeartbeatAgeMs > 15_000 ? "stale" : "healthy"} />
                  <small>{formatLatency(snapshot.metrics.maxWorkerHeartbeatAgeMs)}</small>
                </div>
              </article>
              <article className="signal-row">
                <div>
                  <strong>Recovery path</strong>
                  <p>Replay-safe recovery events visible in the live stream.</p>
                </div>
                <div className="row-end">
                  <StatusPill value="recovery" />
                  <small>{recoveredEvents} recent events</small>
                </div>
              </article>
            </div>
          </article>

          <article className="surface overview-activity-panel">
            <SectionHeader
              eyebrow="Activity"
              title="Recent activity"
              detail="Only the newest transitions that change operator context."
            />
            <motion.div className="activity-timeline" layout transition={LAYOUT_SPRING}>
              <AnimatePresence initial={false}>
                {visibleEvents.slice(0, 6).map((item, index) => (
                  <motion.article
                    key={`${item.timestamp}-${item.kind}-${item.jobId}`}
                    animate={FADE_SLIDE.animate}
                    className="activity-row"
                    exit={FADE_SLIDE.exit}
                    initial={FADE_SLIDE.initial}
                    layout="position"
                    transition={{ ...FAST_TRANSITION, delay: getStaggerDelay(index, 0.015) }}
                  >
                    <span className="activity-row-dot" aria-hidden="true" />
                    <div className="activity-row-copy">
                      <header>
                        <strong>{item.kind}</strong>
                        <span>{formatDateTime(item.timestamp)}</span>
                      </header>
                      <p>{item.message || [item.queue, item.jobId, item.workerId, item.state].filter(Boolean).join(" / ")}</p>
                    </div>
                  </motion.article>
                ))}
              </AnimatePresence>
            </motion.div>
          </article>
        </div>
      </section>

      <section className="surface overview-blocked-panel">
        <SectionHeader
          eyebrow="Workflows"
          title="Blocked work"
          detail="Dependencies waiting on upstream completion."
        />
        {blockedJobs.length === 0 ? (
          <EmptyState title="Dependency graph clear" message="No blocked jobs are waiting on upstream work." />
        ) : (
          <motion.div className="stack-list" layout transition={LAYOUT_SPRING}>
            <AnimatePresence initial={false}>
              {blockedJobs.map((job, index) => (
                <motion.button
                  key={job.id}
                  animate={FADE_SLIDE.animate}
                  className="list-row interactive-row"
                  exit={FADE_SLIDE.exit}
                  initial={FADE_SLIDE.initial}
                  layout="position"
                  transition={{ ...FAST_TRANSITION, delay: getStaggerDelay(index, 0.018) }}
                  type="button"
                  onClick={() => onSelectJob(job.id)}
                >
                  <div>
                    <strong>{job.type}</strong>
                    <p>{job.blockedReason || "waiting on upstream work"}</p>
                  </div>
                  <div className="row-end">
                    <StatusPill value={job.state} />
                    <small>{job.workflowId || "standalone"}</small>
                  </div>
                </motion.button>
              ))}
            </AnimatePresence>
          </motion.div>
        )}
      </section>
    </>
  );
});
