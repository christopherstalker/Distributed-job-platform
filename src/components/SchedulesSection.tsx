import { memo } from "react";
import type { FormEvent } from "react";

import { AnimatePresence, motion } from "framer-motion";

import { EmptyState, InlineFieldError, SectionHeader, StatusPill } from "./ConsolePrimitives";
import { FADE_SLIDE, FAST_TRANSITION, LAYOUT_SPRING, getStaggerDelay } from "../lib/motion";
import type { Schedule, ScheduleDraft } from "../lib/models";
import { autofillGuardProps, formatDateTime, JOB_TYPES, QUEUES } from "../lib/safe";

export const SchedulesSection = memo(function SchedulesSection({
  scheduleDraft,
  scheduleErrors,
  visibleSchedules,
  scheduleFilter,
  busy,
  onSubmit,
  onDraftChange,
  onFilterChange,
  onToggle,
  onTrigger,
}: {
  scheduleDraft: ScheduleDraft;
  scheduleErrors: Record<string, string>;
  visibleSchedules: Schedule[];
  scheduleFilter: string;
  busy: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onDraftChange: <K extends keyof ScheduleDraft>(field: K, value: ScheduleDraft[K]) => void;
  onFilterChange: (value: string) => void;
  onToggle: (schedule: Schedule, enabled: boolean) => void;
  onTrigger: (schedule: Schedule) => void;
}) {
  return (
    <>
      <section className="surface">
        <SectionHeader title="New schedule" detail="Save cron schedules, pause them, and trigger them manually." />
        <form className="form-grid" onSubmit={onSubmit} autoComplete="off">
          <label>
            <span>Name</span>
            <input {...autofillGuardProps} spellCheck={false} value={scheduleDraft.name} onChange={(event) => onDraftChange("name", event.target.value ?? "")} />
            <InlineFieldError message={scheduleErrors.name} />
          </label>
          <label>
            <span>Cron</span>
            <input {...autofillGuardProps} spellCheck={false} value={scheduleDraft.cronExpression} onChange={(event) => onDraftChange("cronExpression", event.target.value ?? "")} />
            <InlineFieldError message={scheduleErrors.cronExpression} />
          </label>
          <label>
            <span>Queue</span>
            <select {...autofillGuardProps} value={scheduleDraft.queue} onChange={(event) => onDraftChange("queue", event.target.value ?? "")}>
              {QUEUES.map((queue) => (
                <option key={queue} value={queue}>
                  {queue}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Type</span>
            <select {...autofillGuardProps} value={scheduleDraft.type} onChange={(event) => onDraftChange("type", event.target.value ?? "")}>
              {JOB_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
            <InlineFieldError message={scheduleErrors.type} />
          </label>
          <label>
            <span>Priority</span>
            <input {...autofillGuardProps} type="number" min="0" max="9" value={scheduleDraft.priority} onChange={(event) => onDraftChange("priority", event.target.value ?? "")} />
          </label>
          <label>
            <span>Timeout seconds</span>
            <input {...autofillGuardProps} type="number" min="0" value={scheduleDraft.timeoutSeconds} onChange={(event) => onDraftChange("timeoutSeconds", event.target.value ?? "")} />
          </label>
          <label>
            <span>Timezone</span>
            <input {...autofillGuardProps} spellCheck={false} value={scheduleDraft.timezone} onChange={(event) => onDraftChange("timezone", event.target.value ?? "")} />
          </label>
          <label className="toggle-row">
            <input checked={scheduleDraft.enabled} type="checkbox" onChange={(event) => onDraftChange("enabled", Boolean(event.target.checked))} />
            <span>Enabled</span>
          </label>
          <label className="full-span">
            <span>Payload</span>
            <textarea {...autofillGuardProps} rows={6} spellCheck={false} value={scheduleDraft.payload} onChange={(event) => onDraftChange("payload", event.target.value ?? "")} />
            <InlineFieldError message={scheduleErrors.payload} />
          </label>
          <div className="button-row full-span">
            <button aria-busy={busy} type="submit" disabled={busy}>
              Save schedule
            </button>
          </div>
        </form>
      </section>

      <section className="surface">
        <SectionHeader title="Schedules" detail="Next run, previous status, and manual trigger controls." />
        <div className="toolbar">
          <label>
            <span>Filter</span>
            <input {...autofillGuardProps} spellCheck={false} value={scheduleFilter} onChange={(event) => onFilterChange(event.target.value ?? "")} />
          </label>
        </div>
        <motion.div className="stack-list" layout transition={LAYOUT_SPRING}>
          {visibleSchedules.length === 0 ? (
            <EmptyState title="No schedules in view" message="Save a schedule or clear the filter." />
          ) : (
            <AnimatePresence initial={false}>
              {visibleSchedules.map((schedule, index) => (
                <motion.article
                  key={schedule.id}
                  animate={FADE_SLIDE.animate}
                  className="list-row"
                  exit={FADE_SLIDE.exit}
                  initial={FADE_SLIDE.initial}
                  layout="position"
                  transition={{ ...FAST_TRANSITION, delay: getStaggerDelay(index, 0.015) }}
                >
                  <div>
                    <strong>{schedule.name}</strong>
                    <p>{schedule.cronExpression} / {schedule.type} / {schedule.queue}</p>
                    <small>next {formatDateTime(schedule.nextRunAt)} / last {formatDateTime(schedule.lastRunAt)}</small>
                  </div>
                  <div className="row-end">
                    <StatusPill value={schedule.enabled ? "enabled" : "paused"} />
                    <div className="button-row compact">
                      <button className="ghost" type="button" onClick={() => onToggle(schedule, !schedule.enabled)}>
                        {schedule.enabled ? "Pause" : "Resume"}
                      </button>
                      <button type="button" onClick={() => onTrigger(schedule)}>
                        Trigger now
                      </button>
                    </div>
                  </div>
                </motion.article>
              ))}
            </AnimatePresence>
          )}
        </motion.div>
      </section>
    </>
  );
});
