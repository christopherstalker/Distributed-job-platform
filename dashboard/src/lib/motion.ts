export const MOTION_EASE = [0.22, 1, 0.36, 1] as const;

export const FAST_TRANSITION = {
  duration: 0.2,
  ease: MOTION_EASE,
} as const;

export const EMPHASIS_TRANSITION = {
  duration: 0.28,
  ease: MOTION_EASE,
} as const;

export const LAYOUT_SPRING = {
  type: "spring",
  stiffness: 340,
  damping: 30,
  mass: 0.72,
} as const;

export const GENTLE_SPRING = {
  type: "spring",
  stiffness: 280,
  damping: 26,
  mass: 0.7,
} as const;

export const FADE_SLIDE = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -8 },
  transition: FAST_TRANSITION,
} as const;

export const FADE_SLIDE_LATERAL = {
  initial: { opacity: 0, x: 14 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: 10 },
  transition: FAST_TRANSITION,
} as const;

export function getStaggerDelay(index: number, step = 0.03) {
  return Math.min(index * step, 0.18);
}
