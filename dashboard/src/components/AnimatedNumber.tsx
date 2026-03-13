import { memo, useEffect, useRef } from "react";

import { animate, useMotionValue, useReducedMotion } from "framer-motion";

import { EMPHASIS_TRANSITION } from "../lib/motion";

export const AnimatedNumber = memo(function AnimatedNumber({
  value,
  formatter,
  className,
  duration = EMPHASIS_TRANSITION.duration,
}: {
  value: number;
  formatter?: (value: number) => string;
  className?: string;
  duration?: number;
}) {
  const normalized = Number.isFinite(value) ? value : 0;
  const reducedMotion = useReducedMotion();
  const motionValue = useMotionValue(normalized);
  const textRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (textRef.current) {
      textRef.current.textContent = formatValue(normalized, formatter);
    }
  }, [formatter, normalized]);

  useEffect(() => {
    if (reducedMotion) {
      motionValue.set(normalized);
      return;
    }

    const controls = animate(motionValue, normalized, {
      ...EMPHASIS_TRANSITION,
      duration,
      onUpdate: (current) => {
        if (textRef.current) {
          textRef.current.textContent = formatValue(current, formatter);
        }
      },
    });

    return () => {
      controls.stop();
    };
  }, [duration, formatter, motionValue, normalized, reducedMotion]);

  return <span ref={textRef} className={className}>{formatValue(normalized, formatter)}</span>;
});

function formatValue(value: number, formatter?: (value: number) => string) {
  if (formatter) {
    return formatter(value);
  }

  return Math.round(value).toLocaleString();
}
