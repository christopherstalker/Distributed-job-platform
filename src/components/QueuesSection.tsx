import { memo } from "react";

import { motion } from "framer-motion";

import { MetricTile, ProgressBar, SectionHeader, StatusPill } from "./ConsolePrimitives";
import { FADE_SLIDE, FAST_TRANSITION, LAYOUT_SPRING, getStaggerDelay } from "../lib/motion";
import type { QueueView } from "../lib/models";

export const QueuesSection = memo(function QueuesSection({
  queueViews,
  controlsEnabled,
  controlsHint,
  onQueueControl,
}: {
  queueViews: QueueView[];
  controlsEnabled: boolean;
  controlsHint?: string;
  onQueueControl: (queueName: string, action: "pause" | "resume" | "drain") => void;
}) {
  return (
    <section className="surface">
      <SectionHeader title="Queues" detail="Backlog, saturation, policy pressure, and operator controls." />
      {controlsHint ? <p className="capability-note">{controlsHint}</p> : null}
      <div className="queue-grid">
        {queueViews.map((queue, index) => (
          <motion.article
            key={queue.queueName}
            animate={FADE_SLIDE.animate}
            className="queue-card queue-card-large"
            initial={FADE_SLIDE.initial}
            transition={{ ...LAYOUT_SPRING, delay: getStaggerDelay(index, 0.02) }}
          >
            <header>
              <div>
                <strong>{queue.queueName}</strong>
                <small>{queue.control?.paused ? "paused" : queue.control?.draining ? "draining" : "flowing"}</small>
              </div>
              <StatusPill value={queue.control?.paused ? "paused" : queue.control?.draining ? "draining" : "healthy"} />
            </header>
            <div className="metric-strip compact">
              <MetricTile label="Backlog" numericValue={queue.backlog} />
              <MetricTile label="Active" numericValue={queue.activeJobs} />
              <MetricTile label="Blocked" numericValue={queue.blocked} />
              <MetricTile label="Dead letter" numericValue={queue.deadLetters} />
            </div>
            <ProgressBar value={queue.saturation} label="live saturation" />
            <div className="stack-list dense">
              {queue.policies.length === 0 ? (
                <p className="muted-copy">No queue-specific policies. Global limits still apply.</p>
              ) : (
                queue.policies.map((policy, policyIndex) => (
                  <motion.article
                    key={policy.policy.id}
                    animate={FADE_SLIDE.animate}
                    className="list-row"
                    initial={FADE_SLIDE.initial}
                    transition={{ ...FAST_TRANSITION, delay: getStaggerDelay(policyIndex, 0.015) }}
                  >
                    <div>
                      <strong>{policy.policy.name}</strong>
                      <p>{policy.policy.mode} / limit {policy.policy.limit}</p>
                    </div>
                    <div className="row-end">
                      <StatusPill value={policy.throttled ? "saturated" : "healthy"} />
                      <small>{policy.policy.mode === "concurrency" ? `${policy.activeCount}` : `${policy.recentCount}`}</small>
                    </div>
                  </motion.article>
                ))
              )}
            </div>
            <div className="button-row">
              <button className="ghost" type="button" disabled={!controlsEnabled} onClick={() => onQueueControl(queue.queueName, "pause")}>
                Pause queue
              </button>
              <button className="ghost" type="button" disabled={!controlsEnabled} onClick={() => onQueueControl(queue.queueName, "resume")}>
                Resume queue
              </button>
              <button type="button" disabled={!controlsEnabled} onClick={() => onQueueControl(queue.queueName, "drain")}>
                Drain queue
              </button>
            </div>
          </motion.article>
        ))}
      </div>
    </section>
  );
});
