import { memo } from "react";

import { motion } from "framer-motion";

import { DetailPair, HeartbeatPulse, MetricTile, ProgressBar, SectionHeader, StatusPill } from "./ConsolePrimitives";
import { FADE_SLIDE, LAYOUT_SPRING, getStaggerDelay } from "../lib/motion";
import type { WorkerView } from "../lib/models";
import { autofillGuardProps, formatDateTime, formatLatency, formatRelative } from "../lib/safe";

export const WorkersSection = memo(function WorkersSection({
  visibleWorkers,
  workerFilter,
  controlsEnabled,
  controlsHint,
  onFilterChange,
  onCordon,
  onInspectLease,
}: {
  visibleWorkers: WorkerView[];
  workerFilter: string;
  controlsEnabled: boolean;
  controlsHint?: string;
  onFilterChange: (value: string) => void;
  onCordon: (workerId: string, cordoned: boolean) => void;
  onInspectLease: (jobId: string) => void;
}) {
  return (
    <section className="surface">
      <SectionHeader title="Workers" detail="Heartbeat, lease ownership, throughput, concurrency, and maintenance state." />
      {controlsHint ? <p className="capability-note">{controlsHint}</p> : null}
      <div className="toolbar">
        <label>
          <span>Search workers</span>
          <input {...autofillGuardProps} spellCheck={false} value={workerFilter} onChange={(event) => onFilterChange(event.target.value ?? "")} />
        </label>
      </div>
      <div className="worker-grid">
        {visibleWorkers.map((worker, index) => (
          <motion.article
            key={worker.workerId}
            animate={FADE_SLIDE.animate}
            className="worker-card surface inset"
            initial={FADE_SLIDE.initial}
            transition={{ ...LAYOUT_SPRING, delay: getStaggerDelay(index, 0.02) }}
          >
            <header>
              <div>
                <div className="worker-title">
                  <HeartbeatPulse healthy={worker.heartbeatAgeMs < 10_000} />
                  <strong>{worker.workerId}</strong>
                </div>
                <small>{worker.hostname}</small>
              </div>
              <StatusPill value={worker.effectiveStatus} />
            </header>
            <div className="metric-strip compact">
              <MetricTile label="Queues" numericValue={worker.queues.length} />
              <MetricTile label="Leases" numericValue={worker.activeLeaseCount} />
              <MetricTile label="Concurrency" numericValue={worker.concurrency} />
              <MetricTile label="Throughput" numericValue={worker.throughput} />
            </div>
            <ProgressBar value={worker.saturation} label="concurrency saturation" />
            <div className="detail-grid detail-grid-dense">
              <DetailPair label="heartbeat age" value={formatLatency(worker.heartbeatAgeMs)} />
              <DetailPair label="oldest lease" value={worker.oldestLeaseJobId || "none"} />
              <DetailPair label="lease expiry" value={worker.leaseExpiresAt ? formatRelative(worker.leaseExpiresAt) : "n/a"} />
              <DetailPair label="started" value={formatDateTime(worker.startedAt)} />
            </div>
            <div className="button-row">
              <button className="ghost" type="button" disabled={!controlsEnabled} onClick={() => onCordon(worker.workerId, true)}>
                Cordon
              </button>
              <button className="ghost" type="button" disabled={!controlsEnabled} onClick={() => onCordon(worker.workerId, false)}>
                Resume
              </button>
              {worker.oldestLeaseJobId ? (
                <button type="button" onClick={() => onInspectLease(worker.oldestLeaseJobId || "")}>
                  Inspect oldest lease
                </button>
              ) : null}
            </div>
          </motion.article>
        ))}
      </div>
    </section>
  );
});
