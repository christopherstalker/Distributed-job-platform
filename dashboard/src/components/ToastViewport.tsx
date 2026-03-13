import { AnimatePresence, motion } from "framer-motion";

import { FADE_SLIDE_LATERAL, FAST_TRANSITION, LAYOUT_SPRING, getStaggerDelay } from "../lib/motion";
import type { Toast } from "../lib/models";

export function ToastViewport({
  items,
  onDismiss,
}: {
  items: Toast[];
  onDismiss: (toastId: string) => void;
}) {
  return (
    <div className="toast-viewport" aria-live="polite" aria-atomic="true">
      <AnimatePresence initial={false}>
        {items.map((item, index) => (
          <motion.article
            key={item.id}
            animate={FADE_SLIDE_LATERAL.animate}
            className={`toast tone-${item.tone}`}
            exit={FADE_SLIDE_LATERAL.exit}
            initial={FADE_SLIDE_LATERAL.initial}
            layout
            transition={{ ...FAST_TRANSITION, delay: getStaggerDelay(index, 0.02) }}
          >
            <div>
              <strong>{item.title}</strong>
              {item.description ? <p>{item.description}</p> : null}
            </div>
            <button className="ghost icon-button" type="button" onClick={() => onDismiss(item.id)} aria-label="Dismiss notification">
              x
            </button>
          </motion.article>
        ))}
      </AnimatePresence>
    </div>
  );
}
