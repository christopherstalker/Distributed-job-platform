import type { ReactNode } from "react";

import { AnimatePresence, motion } from "framer-motion";

import { AnimatedNumber } from "./AnimatedNumber";
import { FAST_TRANSITION } from "../lib/motion";
import { statusTone } from "../lib/safe";

export function StatusPill({ value, pulse = false }: { value: string; pulse?: boolean }) {
  const tone = statusTone(value);
  return (
    <span className={`status-pill tone-${tone} ${pulse ? "is-live" : ""}`}>
      {pulse ? <span className="status-pill-signal" aria-hidden="true" /> : null}
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={value}
          className="status-pill-copy"
          initial={{ opacity: 0, y: 5 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -5 }}
          transition={FAST_TRANSITION}
        >
          {value}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

export function SectionHeader({
  eyebrow,
  title,
  detail,
  action,
}: {
  eyebrow?: string;
  title: string;
  detail?: string;
  action?: ReactNode;
}) {
  return (
    <div className="section-header">
      <div className="section-heading">
        {eyebrow ? <p className="section-eyebrow">{eyebrow}</p> : null}
        <h2>{title}</h2>
        {detail ? <p>{detail}</p> : null}
      </div>
      {action ? <div className="section-actions">{action}</div> : null}
    </div>
  );
}

export function EmptyState({
  title,
  message,
  action,
}: {
  title: string;
  message: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-orbit" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div className="empty-copy">
        <strong>{title}</strong>
        <p>{message}</p>
      </div>
      {action}
    </div>
  );
}

export function InlineFieldError({ message }: { message?: string }) {
  if (!message) {
    return null;
  }
  return <small className="inline-error">{message}</small>;
}

export function ProgressBar({ value, label }: { value: number; label: string }) {
  const clamped = Math.min(Math.max(value, 0), 100);

  return (
    <div className="progress-row">
      <span>{label}</span>
      <div className="progress-track" aria-hidden="true">
        <motion.span
          animate={{ scaleX: clamped / 100 }}
          initial={false}
          transition={FAST_TRANSITION}
          style={{ transformOrigin: "0% 50%" }}
        />
      </div>
      <strong>{Math.round(clamped)}%</strong>
    </div>
  );
}

export function HeartbeatPulse({ healthy }: { healthy: boolean }) {
  return <span className={`heartbeat-pulse ${healthy ? "healthy" : "stale"}`} aria-hidden="true" />;
}

export function MetricTile({
  className,
  label,
  value,
  numericValue,
  valueFormatter,
  detail,
  tone = "neutral",
  size = "standard",
}: {
  className?: string;
  label: string;
  value?: string;
  numericValue?: number;
  valueFormatter?: (value: number) => string;
  detail?: string;
  tone?: "neutral" | "cyan" | "emerald" | "amber" | "rose";
  size?: "standard" | "compact" | "feature";
}) {
  const resolvedValue = numericValue !== undefined
    ? (
      <AnimatedNumber
        className="metric-value"
        formatter={valueFormatter}
        value={numericValue}
      />
    )
    : (
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={`${label}-${value ?? ""}`}
          className="metric-value"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={FAST_TRANSITION}
        >
          {value}
        </motion.span>
      </AnimatePresence>
    );

  return (
    <article className={["metric-tile", `tone-${tone}`, `size-${size}`, className].filter(Boolean).join(" ")}>
      <span>{label}</span>
      <strong>{resolvedValue}</strong>
      {detail ? <small>{detail}</small> : null}
    </article>
  );
}

export function DetailPair({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="detail-pair">
      <span>{label}</span>
      <strong>{value}</strong>
      {detail ? <small>{detail}</small> : null}
    </div>
  );
}
