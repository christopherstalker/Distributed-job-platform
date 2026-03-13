import { memo } from "react";

import { DetailPair, EmptyState, SectionHeader, StatusPill } from "./ConsolePrimitives";
import type { DashboardSnapshot, Job } from "../lib/models";
import { formatLatency, payloadPreview } from "../lib/safe";

export const SideRail = memo(function SideRail({
  snapshot,
  selectedJob,
  onOpenJobs,
}: {
  snapshot: DashboardSnapshot;
  selectedJob: Job | null;
  onOpenJobs: () => void;
}) {
  const staleWorkers = snapshot.workers.filter((worker) => worker.heartbeatAgeMs > 15_000).length;

  return (
    <>
      <section className="surface rail-panel rail-panel-watch">
        <SectionHeader
          eyebrow="Watchlist"
          title="Watchlist"
          detail="Signals that deserve a second look."
        />
        <div className="signal-list">
          <article className="signal-row">
            <div>
              <strong>Dead letter</strong>
              <p>{snapshot.deadLetters.length} jobs waiting on operator recovery</p>
            </div>
            <div className="row-end">
              <StatusPill value={snapshot.deadLetters.length > 0 ? "degraded" : "healthy"} />
              <small>{snapshot.deadLetters.length} jobs</small>
            </div>
          </article>
          <article className="signal-row">
            <div>
              <strong>Throttle pressure</strong>
              <p>{snapshot.rateLimits.filter((item) => item.throttled).length} saturated policies</p>
            </div>
            <div className="row-end">
              <StatusPill value={snapshot.overview.throttledJobs > 0 ? "degraded" : "healthy"} />
              <small>{snapshot.overview.throttledJobs} jobs</small>
            </div>
          </article>
          <article className="signal-row">
            <div>
              <strong>Heartbeat drift</strong>
              <p>{staleWorkers} workers beyond the heartbeat threshold</p>
            </div>
            <div className="row-end">
              <StatusPill value={staleWorkers > 0 ? "stale" : "healthy"} />
              <small>{formatLatency(snapshot.metrics.maxWorkerHeartbeatAgeMs)}</small>
            </div>
          </article>
        </div>
      </section>

      <section className="surface rail-panel rail-panel-selection">
        <SectionHeader
          eyebrow="Inspect"
          title="Selected job"
          detail="The current drawer target, without opening the drawer."
        />
        {selectedJob ? (
          <div className="stack-list dense">
            <article className="list-row">
              <div>
                <strong>{selectedJob.type}</strong>
                <p>{selectedJob.id}</p>
              </div>
              <StatusPill value={selectedJob.state} />
            </article>
            <DetailPair label="queue" value={selectedJob.queue} />
            <DetailPair label="worker" value={selectedJob.workerId || "unassigned"} />
            <DetailPair label="idempotency" value={selectedJob.idempotencyKey || "not set"} />
            <DetailPair label="payload" value={payloadPreview(selectedJob.payload)} />
            <button type="button" onClick={onOpenJobs}>
              Open jobs view
            </button>
          </div>
        ) : (
          <EmptyState title="No job selected" message="Select a job to inspect payload, attempts, and recovery history." />
        )}
      </section>
    </>
  );
});
