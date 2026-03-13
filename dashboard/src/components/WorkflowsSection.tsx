import { memo } from "react";

import { AnimatePresence, motion } from "framer-motion";

import { EmptyState, SectionHeader, StatusPill } from "./ConsolePrimitives";
import { FADE_SLIDE, FAST_TRANSITION, LAYOUT_SPRING, getStaggerDelay } from "../lib/motion";

export const WorkflowsSection = memo(function WorkflowsSection({
  workflowNodes,
}: {
  workflowNodes: Array<{ jobId: string; type: string; state: string; queue: string; parentJobId?: string; blockedReason?: string }>;
}) {
  return (
    <section className="surface">
      <SectionHeader title="Workflow graph" detail="Selected job lineage and blocked dependencies." />
      {workflowNodes.length === 0 ? (
        <EmptyState title="Select a workflow job" message="Choose a workflow-backed job to inspect its dependency graph." />
      ) : (
        <motion.div className="workflow-grid" layout transition={LAYOUT_SPRING}>
          <AnimatePresence initial={false}>
            {workflowNodes.map((node, index) => (
              <motion.article
                key={node.jobId}
                animate={FADE_SLIDE.animate}
                className="graph-card"
                exit={FADE_SLIDE.exit}
                initial={FADE_SLIDE.initial}
                layout="position"
                transition={{ ...FAST_TRANSITION, delay: getStaggerDelay(index, 0.015) }}
              >
                <header>
                  <strong>{node.type}</strong>
                  <StatusPill value={node.state} />
                </header>
                <p>{node.blockedReason || `${node.queue} queue / parent ${node.parentJobId || "root"}`}</p>
                <small>{node.jobId}</small>
              </motion.article>
            ))}
          </AnimatePresence>
        </motion.div>
      )}
    </section>
  );
});
