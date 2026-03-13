import { memo } from "react";

import { AnimatePresence, motion } from "framer-motion";

import { EmptyState, SectionHeader } from "./ConsolePrimitives";
import { FADE_SLIDE, FAST_TRANSITION, LAYOUT_SPRING, getStaggerDelay } from "../lib/motion";
import type { SystemEvent } from "../lib/models";
import { autofillGuardProps, formatDateTime } from "../lib/safe";

export const EventsSection = memo(function EventsSection({
  visibleEvents,
  eventFilter,
  onFilterChange,
}: {
  visibleEvents: SystemEvent[];
  eventFilter: string;
  onFilterChange: (value: string) => void;
}) {
  return (
    <section className="surface">
      <SectionHeader
        title="Events"
        detail="Filterable chronology across jobs, queues, workers, and leadership."
        action={<small>{visibleEvents.length} in view</small>}
      />
      <div className="toolbar">
        <label>
          <span>Filter</span>
          <input {...autofillGuardProps} spellCheck={false} value={eventFilter} onChange={(event) => onFilterChange(event.target.value ?? "")} />
        </label>
      </div>
      <motion.div className="event-feed" layout transition={LAYOUT_SPRING}>
        {visibleEvents.length === 0 ? (
          <EmptyState title="Awaiting matching events" message="Adjust the filter or wait for the next transition." />
        ) : (
          <AnimatePresence initial={false}>
            {visibleEvents.map((item, index) => (
              <motion.article
                key={`${item.timestamp}-${item.kind}-${item.jobId}`}
                animate={FADE_SLIDE.animate}
                className="event-card"
                exit={FADE_SLIDE.exit}
                initial={FADE_SLIDE.initial}
                layout="position"
                transition={{ ...FAST_TRANSITION, delay: getStaggerDelay(index, 0.012) }}
              >
                <header>
                  <strong>{item.kind}</strong>
                  <span>{formatDateTime(item.timestamp)}</span>
                </header>
                <p>{item.message || [item.queue, item.workerId, item.jobId, item.state].filter(Boolean).join(" / ")}</p>
              </motion.article>
            ))}
          </AnimatePresence>
        )}
      </motion.div>
    </section>
  );
});
