import { memo } from "react";
import type { FormEvent } from "react";

import { AnimatePresence, motion } from "framer-motion";

import { EmptyState, InlineFieldError, SectionHeader, StatusPill } from "./ConsolePrimitives";
import { FADE_SLIDE, FAST_TRANSITION, getStaggerDelay } from "../lib/motion";
import type { Job, JobDraft } from "../lib/models";
import { autofillGuardProps, formatLatency, formatRelative, JOB_TYPES, QUEUES } from "../lib/safe";

export const JobsSection = memo(function JobsSection({
  visibleJobs,
  jobDraft,
  jobFilters,
  jobFormErrors,
  busy,
  priorityControlsEnabled,
  priorityControlsHint,
  onSubmit,
  onJobDraftChange,
  onJobFiltersChange,
  onSeedWorkflow,
  onSelectJob,
  onRetryJob,
  onCancelJob,
  onAdjustPriority,
}: {
  visibleJobs: Job[];
  jobDraft: JobDraft;
  jobFilters: { state: string; queue: string; sort: string; tenant: string };
  jobFormErrors: Record<string, string>;
  busy: { submit: boolean; seed: boolean; retry: (jobId: string) => boolean; cancel: (jobId: string) => boolean };
  priorityControlsEnabled: boolean;
  priorityControlsHint?: string;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onJobDraftChange: (field: keyof JobDraft, value: string) => void;
  onJobFiltersChange: (next: Partial<{ state: string; queue: string; sort: string; tenant: string }>) => void;
  onSeedWorkflow: () => void;
  onSelectJob: (jobId: string) => void;
  onRetryJob: (jobId: string) => void;
  onCancelJob: (jobId: string) => void;
  onAdjustPriority: (jobId: string, delta: number) => void;
}) {
  return (
    <>
      <section className="surface">
        <SectionHeader title="New job" detail="Queue a one-off job with schedule, dedupe, and dependency controls." />
        <form className="form-grid" onSubmit={onSubmit} autoComplete="off">
          <label>
            <span>Type</span>
            <select {...autofillGuardProps} value={jobDraft.type} onChange={(event) => onJobDraftChange("type", event.target.value ?? "")}>
              {JOB_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
            <InlineFieldError message={jobFormErrors.type} />
          </label>
          <label>
            <span>Queue</span>
            <select {...autofillGuardProps} value={jobDraft.queue} onChange={(event) => onJobDraftChange("queue", event.target.value ?? "")}>
              {QUEUES.map((queue) => (
                <option key={queue} value={queue}>
                  {queue}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Tenant</span>
            <input {...autofillGuardProps} spellCheck={false} value={jobDraft.tenantId} onChange={(event) => onJobDraftChange("tenantId", event.target.value ?? "")} />
            <InlineFieldError message={jobFormErrors.tenantId} />
          </label>
          <label>
            <span>Priority</span>
            <input {...autofillGuardProps} inputMode="numeric" type="number" min="0" max="9" value={jobDraft.priority} onChange={(event) => onJobDraftChange("priority", event.target.value ?? "")} />
            <InlineFieldError message={jobFormErrors.priority} />
          </label>
          <label>
            <span>Max attempts</span>
            <input {...autofillGuardProps} inputMode="numeric" type="number" min="1" value={jobDraft.maxAttempts} onChange={(event) => onJobDraftChange("maxAttempts", event.target.value ?? "")} />
          </label>
          <label>
            <span>Timeout seconds</span>
            <input {...autofillGuardProps} inputMode="numeric" type="number" min="0" value={jobDraft.timeoutSeconds} onChange={(event) => onJobDraftChange("timeoutSeconds", event.target.value ?? "")} />
          </label>
          <label>
            <span>Delay seconds</span>
            <input {...autofillGuardProps} inputMode="numeric" type="number" min="0" value={jobDraft.delaySeconds} onChange={(event) => onJobDraftChange("delaySeconds", event.target.value ?? "")} />
          </label>
          <label>
            <span>Scheduled at</span>
            <input {...autofillGuardProps} type="datetime-local" value={jobDraft.scheduledAt} onChange={(event) => onJobDraftChange("scheduledAt", event.target.value ?? "")} />
            <InlineFieldError message={jobFormErrors.scheduledAt} />
          </label>
          <label>
            <span>Workflow ID</span>
            <input {...autofillGuardProps} spellCheck={false} placeholder="optional" value={jobDraft.workflowId} onChange={(event) => onJobDraftChange("workflowId", event.target.value ?? "")} />
          </label>
          <label>
            <span>Dependencies</span>
            <input {...autofillGuardProps} spellCheck={false} placeholder="job-id, job-id" value={jobDraft.dependencies} onChange={(event) => onJobDraftChange("dependencies", event.target.value ?? "")} />
          </label>
          <label>
            <span>Idempotency key</span>
            <input {...autofillGuardProps} spellCheck={false} placeholder="optional" value={jobDraft.idempotencyKey} onChange={(event) => onJobDraftChange("idempotencyKey", event.target.value ?? "")} />
          </label>
          <label>
            <span>Dedupe window seconds</span>
            <input {...autofillGuardProps} inputMode="numeric" type="number" min="0" value={jobDraft.dedupeWindowSeconds} onChange={(event) => onJobDraftChange("dedupeWindowSeconds", event.target.value ?? "")} />
          </label>
          <label className="full-span">
            <span>Payload</span>
            <textarea {...autofillGuardProps} rows={8} spellCheck={false} value={jobDraft.payload} onChange={(event) => onJobDraftChange("payload", event.target.value ?? "")} />
            <InlineFieldError message={jobFormErrors.payload} />
          </label>
          <div className="button-row full-span">
            <button aria-busy={busy.submit} type="submit" disabled={busy.submit}>
              Submit Job
            </button>
            <button aria-busy={busy.seed} className="ghost" type="button" onClick={onSeedWorkflow} disabled={busy.seed}>
              Seed Demo Workflow
            </button>
          </div>
        </form>
      </section>

      <section className="surface">
        <SectionHeader title="Recent jobs" detail="Sortable execution history with inline recovery actions." action={<small>{visibleJobs.length} in view</small>} />
        {priorityControlsHint ? <p className="capability-note">{priorityControlsHint}</p> : null}
        <div className="toolbar">
          <label>
            <span>State</span>
            <select value={jobFilters.state} onChange={(event) => onJobFiltersChange({ state: event.target.value ?? "all" })}>
              <option value="all">all</option>
              <option value="queued">queued</option>
              <option value="scheduled">scheduled</option>
              <option value="active">active</option>
              <option value="retrying">retrying</option>
              <option value="blocked">blocked</option>
              <option value="throttled">throttled</option>
              <option value="completed">completed</option>
              <option value="failed">failed</option>
              <option value="canceled">canceled</option>
            </select>
          </label>
          <label>
            <span>Queue</span>
            <select value={jobFilters.queue} onChange={(event) => onJobFiltersChange({ queue: event.target.value ?? "all" })}>
              <option value="all">all</option>
              {QUEUES.map((queue) => (
                <option key={queue} value={queue}>
                  {queue}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Tenant</span>
            <input {...autofillGuardProps} spellCheck={false} value={jobFilters.tenant} onChange={(event) => onJobFiltersChange({ tenant: event.target.value ?? "" })} />
          </label>
          <label>
            <span>Sort</span>
            <select value={jobFilters.sort} onChange={(event) => onJobFiltersChange({ sort: event.target.value ?? "updated" })}>
              <option value="updated">last updated</option>
              <option value="created">created</option>
              <option value="priority">priority</option>
              <option value="latency">latency</option>
            </select>
          </label>
        </div>
        {visibleJobs.length === 0 ? (
          <EmptyState title="No jobs in view" message="Relax the filters or queue fresh work." />
        ) : (
          <div className="table-shell">
            <table>
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Status</th>
                  <th>Attempts</th>
                  <th>Lease / throttling</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <motion.tbody initial={false}>
                <AnimatePresence initial={false}>
                  {visibleJobs.map((job, index) => (
                    <motion.tr
                      key={job.id}
                      animate={FADE_SLIDE.animate}
                      exit={FADE_SLIDE.exit}
                      initial={FADE_SLIDE.initial}
                      layout="position"
                      transition={{ ...FAST_TRANSITION, delay: getStaggerDelay(index, 0.01) }}
                    >
                    <td>
                      <button className="table-link" type="button" onClick={() => onSelectJob(job.id)}>
                        <strong>{job.type}</strong>
                        <small>{job.id.slice(0, 8)} / {job.queue} / {job.tenantId}</small>
                        {job.idempotencyKey ? <small>idempotency {job.idempotencyKey}</small> : null}
                      </button>
                    </td>
                    <td>
                      <StatusPill value={job.state} />
                      <small>{job.workflowId ? `workflow ${job.workflowId.slice(0, 8)}` : "single job"}</small>
                    </td>
                    <td>
                      <strong>{job.attempts}/{job.maxAttempts}</strong>
                      <small>{job.executionMs > 0 ? formatLatency(job.executionMs) : "not executed"}</small>
                    </td>
                    <td>
                      <strong>{job.leaseExpiresAt ? formatRelative(job.leaseExpiresAt) : job.throttleUntil ? formatRelative(job.throttleUntil) : "n/a"}</strong>
                      <small>{job.blockedReason || job.lastError || "healthy"}</small>
                    </td>
                    <td>
                      <div className="table-actions">
                        <button aria-busy={busy.retry(job.id)} className="ghost" type="button" onClick={() => onRetryJob(job.id)} disabled={busy.retry(job.id)}>
                          Retry
                        </button>
                        <button aria-busy={busy.cancel(job.id)} className="ghost" type="button" onClick={() => onCancelJob(job.id)} disabled={busy.cancel(job.id)}>
                          Cancel
                        </button>
                        <button className="ghost" type="button" onClick={() => onAdjustPriority(job.id, 1)} disabled={!priorityControlsEnabled}>
                          Priority +
                        </button>
                      </div>
                    </td>
                    </motion.tr>
                  ))}
                </AnimatePresence>
              </motion.tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
});
