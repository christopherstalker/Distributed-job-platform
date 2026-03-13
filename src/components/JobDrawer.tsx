import { memo, useEffect, useState } from "react";

import { AnimatePresence, motion } from "framer-motion";

import { FADE_SLIDE, FAST_TRANSITION, LAYOUT_SPRING, getStaggerDelay } from "../lib/motion";
import type { JobInspection } from "../lib/models";
import {
  QUEUES,
  formatDateTime,
  formatLatency,
  formatRelative,
  payloadPreview,
  safeTrim,
  stringifyJson,
} from "../lib/safe";
import { EmptyState, InlineFieldError, SectionHeader, StatusPill } from "./ConsolePrimitives";

type JobDrawerProps = {
  inspection: JobInspection | null;
  busy: boolean;
  updating: boolean;
  detailError?: string;
  lastUpdatedAt?: string;
  priorityControlsEnabled: boolean;
  priorityControlsHint?: string;
  onClose: () => void;
  onRetry: (jobId: string) => void;
  onCancel: (jobId: string) => void;
  onReplay: (jobId: string, queue: string, payloadText: string, edited: boolean) => void;
  onPriorityChange: (jobId: string, delta: number) => void;
};

export const JobDrawer = memo(function JobDrawer({
  inspection,
  busy,
  updating,
  detailError,
  lastUpdatedAt,
  priorityControlsEnabled,
  priorityControlsHint,
  onClose,
  onRetry,
  onCancel,
  onReplay,
  onPriorityChange,
}: JobDrawerProps) {
  const [replayQueue, setReplayQueue] = useState("default");
  const [payloadText, setPayloadText] = useState("{}");
  const [inlineError, setInlineError] = useState("");

  useEffect(() => {
    if (!inspection) {
      return;
    }

    setReplayQueue(inspection.job.queue || "default");
    setPayloadText(stringifyJson(inspection.deadLetter?.job?.payload ?? inspection.job.payload));
    setInlineError("");
  }, [inspection?.job.id]);

  return (
    <AnimatePresence initial={false}>
      {inspection ? (
        <>
          <motion.div
            className="drawer-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            onClick={onClose}
          />
          <motion.aside
            className="job-drawer surface"
            initial={{ opacity: 0, x: 28 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 28 }}
            transition={LAYOUT_SPRING}
          >
            <header className="drawer-header">
              <div>
                <span className="eyebrow">Job Inspection</span>
                <h2>{inspection.job.type}</h2>
                <p>{inspection.job.id}</p>
              </div>
              <div className="drawer-header-actions">
                <StatusPill value={inspection.job.state} />
                <button className="ghost icon-button" type="button" onClick={onClose} aria-label="Close details">
                  x
                </button>
              </div>
            </header>

            <div className="drawer-status-row">
              <small>{updating ? "Updating details..." : detailError ? "Showing cached details" : "Details in sync"}</small>
              <small>{lastUpdatedAt ? `Last detail refresh ${formatRelative(lastUpdatedAt)}` : "No detail refresh yet"}</small>
            </div>
            {detailError ? <p className="drawer-inline-error">{detailError}</p> : null}
            {priorityControlsHint ? <p className="capability-note">{priorityControlsHint}</p> : null}

            <div className="drawer-actions">
              <button aria-busy={busy} type="button" disabled={busy} onClick={() => onRetry(inspection.job.id)}>
                Retry
              </button>
              <button aria-busy={busy} className="ghost" type="button" disabled={busy} onClick={() => onCancel(inspection.job.id)}>
                Cancel
              </button>
              <button className="ghost" type="button" disabled={busy || !priorityControlsEnabled} onClick={() => onPriorityChange(inspection.job.id, 1)}>
                Priority +
              </button>
              <button className="ghost" type="button" disabled={busy || !priorityControlsEnabled} onClick={() => onPriorityChange(inspection.job.id, -1)}>
                Priority -
              </button>
            </div>

            <section className="drawer-section">
              <SectionHeader title="Profile" detail="Lease, retry, and lifecycle state for the selected job." />
              <div className="detail-grid">
                <DetailCard label="Queue" value={inspection.job.queue} />
                <DetailCard label="Tenant" value={inspection.job.tenantId} />
                <DetailCard label="Worker" value={inspection.job.workerId || "unassigned"} />
                <DetailCard label="Priority" value={String(inspection.job.priority)} />
                <DetailCard label="Lease" value={inspection.job.leaseExpiresAt ? formatRelative(inspection.job.leaseExpiresAt) : "not leased"} />
                <DetailCard label="Heartbeat" value={inspection.job.lastHeartbeatAt ? formatRelative(inspection.job.lastHeartbeatAt) : "n/a"} />
                <DetailCard label="Created" value={formatDateTime(inspection.job.createdAt)} />
                <DetailCard label="Started" value={formatDateTime(inspection.job.startedAt)} />
                <DetailCard label="Completed" value={formatDateTime(inspection.job.finishedAt)} />
                <DetailCard label="Execution" value={inspection.job.executionMs > 0 ? formatLatency(inspection.job.executionMs) : "pending"} />
                <DetailCard label="Attempts" value={`${inspection.job.attempts}/${inspection.job.maxAttempts}`} />
                <DetailCard label="Retry ETA" value={inspection.job.runAt ? formatRelative(inspection.job.runAt) : "n/a"} />
              </div>
            </section>

            <section className="drawer-section">
              <SectionHeader title="Failure and recovery" detail="Dead-letter metadata, orphan recovery, and idempotency controls." />
              <div className="drawer-mini-grid">
                <article className="mini-card">
                  <span>Failure reason</span>
                  <strong>{inspection.deadLetter?.errorMessage || inspection.job.lastError || "healthy"}</strong>
                  <small>{inspection.deadLetter?.errorType || inspection.job.blockedReason || "No active failure signal."}</small>
                </article>
                <article className="mini-card">
                  <span>Idempotency</span>
                  <strong>{inspection.job.idempotencyKey || "No key"}</strong>
                  <small>
                    {inspection.idempotency
                      ? `Suppression active until ${formatDateTime(inspection.idempotency.expiresAt)}`
                      : "Platform default duplicate window is 15 minutes unless overridden at submit time."}
                  </small>
                </article>
                <article className="mini-card">
                  <span>Lease ownership</span>
                  <strong>{inspection.job.workerId || "Unclaimed"}</strong>
                  <small>
                    {inspection.job.leaseToken
                      ? `Lease token ${inspection.job.leaseToken}`
                      : "No worker lease is attached to this job right now."}
                  </small>
                </article>
              </div>
            </section>

            <section className="drawer-section">
              <SectionHeader title="Replay" detail="Replay the original payload or edit it before resubmission." />
              <div className="field-grid">
                <label>
                  <span>Replay queue</span>
                  <select value={replayQueue} onChange={(event) => setReplayQueue(event.target.value)}>
                    {QUEUES.map((queue) => (
                      <option key={queue} value={queue}>
                        {queue}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label>
                <span>Replay payload</span>
                <textarea
                  rows={7}
                  value={payloadText}
                  onChange={(event) => {
                    setPayloadText(event.target.value);
                    setInlineError("");
                  }}
                />
              </label>
              <InlineFieldError message={inlineError} />
              <div className="drawer-actions">
                <button aria-busy={busy} type="button" disabled={busy} onClick={() => onReplay(inspection.job.id, replayQueue, payloadText, false)}>
                  Replay Same Payload
                </button>
                <button
                  aria-busy={busy}
                  className="ghost"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    if (!safeTrim(payloadText)) {
                      setInlineError("Replay payload cannot be empty when editing.");
                      return;
                    }
                    onReplay(inspection.job.id, replayQueue, payloadText, true);
                  }}
                >
                  Replay Edited Payload
                </button>
              </div>
            </section>

            <section className="drawer-section">
              <SectionHeader title="Attempts" detail="Attempt history with worker ownership and lease-expiry markers." />
              {inspection.attempts.length === 0 ? (
                <EmptyState title="No attempts yet" message="This job has not started execution." />
              ) : (
                <div className="attempt-list">
                  {inspection.attempts.map((attempt, index) => (
                    <motion.article
                      key={`${attempt.jobId}-${attempt.attempt}`}
                      animate={FADE_SLIDE.animate}
                      className="attempt-card"
                      initial={FADE_SLIDE.initial}
                      layout="position"
                      transition={{ ...FAST_TRANSITION, delay: getStaggerDelay(index, 0.015) }}
                    >
                      <header>
                        <div>
                          <strong>Attempt {attempt.attempt}</strong>
                          <small>{attempt.workerId || "unknown worker"}</small>
                        </div>
                        <StatusPill value={attempt.status} />
                      </header>
                      <p>{attempt.errorMessage || attempt.errorType || "No attempt error recorded."}</p>
                      <div className="attempt-meta">
                        <span>{formatDateTime(attempt.startedAt)}</span>
                        <span>{attempt.finishedAt ? formatDateTime(attempt.finishedAt) : "running"}</span>
                        {attempt.leaseExpired ? <span className="warning-copy">lease expired</span> : null}
                      </div>
                    </motion.article>
                  ))}
                </div>
              )}
            </section>

            <section className="drawer-section">
              <SectionHeader title="Payload and result" detail="Compact previews plus full JSON for deeper inspection." />
              <div className="payload-panels">
                <article className="payload-card">
                  <header>
                    <strong>Payload</strong>
                    <small>{payloadPreview(inspection.job.payload)}</small>
                  </header>
                  <pre>{stringifyJson(inspection.job.payload)}</pre>
                </article>
                <article className="payload-card">
                  <header>
                    <strong>Result</strong>
                    <small>{inspection.job.result ? payloadPreview(inspection.job.result) : "no result"}</small>
                  </header>
                  <pre>{inspection.job.result ? stringifyJson(inspection.job.result) : "// no result emitted"}</pre>
                </article>
              </div>
            </section>

            <section className="drawer-section">
              <SectionHeader title="Dependencies" detail="Compact DAG context for blocked fan-out and fan-in work." />
              {inspection.graph.nodes.length === 0 ? (
                <EmptyState title="No dependency graph" message="This job is not part of a workflow." />
              ) : (
                <div className="graph-list">
                  {inspection.graph.nodes.map((node, index) => (
                    <motion.article
                      key={node.jobId}
                      animate={FADE_SLIDE.animate}
                      className="graph-card"
                      initial={FADE_SLIDE.initial}
                      layout="position"
                      transition={{ ...FAST_TRANSITION, delay: getStaggerDelay(index, 0.015) }}
                    >
                      <header>
                        <strong>{node.type}</strong>
                        <StatusPill value={node.state} />
                      </header>
                      <p>{node.blockedReason || `${node.dependsOn?.length ?? 0} upstream / ${node.dependents?.length ?? 0} downstream`}</p>
                      <small>{node.jobId}</small>
                    </motion.article>
                  ))}
                </div>
              )}
            </section>

            <section className="drawer-section">
              <SectionHeader title="Timeline" detail="Event chronology for lease recovery, retries, and operator actions." />
              {inspection.events.length === 0 ? (
                <EmptyState title="No events yet" message="This job has not emitted timeline entries." />
              ) : (
                <div className="timeline-list">
                  {inspection.events.map((item, index) => (
                    <motion.article
                      key={`${item.type}-${item.occurredAt}`}
                      animate={FADE_SLIDE.animate}
                      className="timeline-card"
                      initial={FADE_SLIDE.initial}
                      layout="position"
                      transition={{ ...FAST_TRANSITION, delay: getStaggerDelay(index, 0.015) }}
                    >
                      <header>
                        <strong>{item.type}</strong>
                        <span>{formatDateTime(item.occurredAt)}</span>
                      </header>
                      <p>{item.message}</p>
                    </motion.article>
                  ))}
                </div>
              )}
            </section>
          </motion.aside>
        </>
      ) : null}
    </AnimatePresence>
  );
});

function DetailCard({ label, value }: { label: string; value: string }) {
  return (
    <article className="detail-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}
