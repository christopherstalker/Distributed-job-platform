import { memo } from "react";

import { AnimatePresence, motion } from "framer-motion";

import { EmptyState, SectionHeader, StatusPill } from "./ConsolePrimitives";
import { FADE_SLIDE, FAST_TRANSITION, LAYOUT_SPRING, getStaggerDelay } from "../lib/motion";
import type { DashboardSnapshot } from "../lib/models";
import { autofillGuardProps, formatDateTime, safeTrim, QUEUES } from "../lib/safe";

export const DeadLetterSection = memo(function DeadLetterSection({
  visibleDeadLetters,
  selectedDeadLetters,
  deadLetterFilters,
  bulkReplayQueue,
  bulkReplayPayload,
  busy,
  onFiltersChange,
  onReplayQueueChange,
  onReplayPayloadChange,
  onReplaySelected,
  onDeleteSelected,
  onToggleSelection,
  onSelectJob,
}: {
  visibleDeadLetters: DashboardSnapshot["deadLetters"];
  selectedDeadLetters: string[];
  deadLetterFilters: { queue: string; errorType: string; search: string };
  bulkReplayQueue: string;
  bulkReplayPayload: string;
  busy: { replay: boolean; delete: boolean };
  onFiltersChange: (next: Partial<{ queue: string; errorType: string; search: string }>) => void;
  onReplayQueueChange: (value: string) => void;
  onReplayPayloadChange: (value: string) => void;
  onReplaySelected: () => void;
  onDeleteSelected: () => void;
  onToggleSelection: (jobId: string) => void;
  onSelectJob: (jobId: string) => void;
}) {
  return (
    <section className="surface">
      <SectionHeader title="Dead letter" detail="Filter failures, replay them in bulk, or clear processed metadata." />
      <div className="toolbar toolbar-wide">
        <label>
          <span>Queue</span>
          <select value={deadLetterFilters.queue} onChange={(event) => onFiltersChange({ queue: event.target.value ?? "all" })}>
            <option value="all">all</option>
            {QUEUES.map((queue) => (
              <option key={queue} value={queue}>
                {queue}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Error type</span>
          <select value={deadLetterFilters.errorType} onChange={(event) => onFiltersChange({ errorType: event.target.value ?? "all" })}>
            <option value="all">all</option>
            {[...new Set(visibleDeadLetters.map((item) => safeTrim(item.errorType)).filter(Boolean))].map((errorType) => (
              <option key={errorType} value={errorType}>
                {errorType}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Search</span>
          <input {...autofillGuardProps} spellCheck={false} value={deadLetterFilters.search} onChange={(event) => onFiltersChange({ search: event.target.value ?? "" })} />
        </label>
        <label>
          <span>Replay queue</span>
          <select value={bulkReplayQueue} onChange={(event) => onReplayQueueChange(event.target.value ?? "default")}>
            {QUEUES.map((queue) => (
              <option key={queue} value={queue}>
                {queue}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label>
        <span>Replay payload override</span>
        <textarea
          {...autofillGuardProps}
          rows={5}
          spellCheck={false}
          placeholder="Optional JSON payload override"
          value={bulkReplayPayload}
          onChange={(event) => onReplayPayloadChange(event.target.value ?? "")}
        />
      </label>
      <div className="button-row">
        <button aria-busy={busy.replay} type="button" onClick={onReplaySelected} disabled={busy.replay}>
          Replay selected
        </button>
        <button aria-busy={busy.delete} className="ghost" type="button" onClick={onDeleteSelected} disabled={busy.delete}>
          Delete selected
        </button>
      </div>
      <motion.div className="stack-list" layout transition={LAYOUT_SPRING}>
        {visibleDeadLetters.length === 0 ? (
          <EmptyState title="DLQ is clear" message="No failed jobs match the current filter." />
        ) : (
          <AnimatePresence initial={false}>
            {visibleDeadLetters.map((item, index) => (
              <motion.article
                key={item.jobId}
                animate={FADE_SLIDE.animate}
                className="list-row dead-letter-row"
                exit={FADE_SLIDE.exit}
                initial={FADE_SLIDE.initial}
                layout="position"
                transition={{ ...FAST_TRANSITION, delay: getStaggerDelay(index, 0.012) }}
              >
                <label className="checkbox-cell">
                  <input checked={selectedDeadLetters.includes(item.jobId)} type="checkbox" onChange={() => onToggleSelection(item.jobId)} />
                  <span />
                </label>
                <div>
                  <button className="table-link" type="button" onClick={() => onSelectJob(item.jobId)}>
                    <strong>{item.job?.type || item.jobId.slice(0, 8)}</strong>
                  </button>
                  <p>{item.errorType || "failure"} / {item.errorMessage}</p>
                  <small>failed {formatDateTime(item.failedAt)} / replayed {item.replayCount} times</small>
                </div>
                <div className="row-end">
                  <StatusPill value="failed" />
                  <small>{item.queue}</small>
                </div>
              </motion.article>
            ))}
          </AnimatePresence>
        )}
      </motion.div>
    </section>
  );
});
