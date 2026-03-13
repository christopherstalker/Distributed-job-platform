import { memo, useId, useMemo } from "react";

import { motion } from "framer-motion";

import { AnimatedNumber } from "./AnimatedNumber";
import { EMPHASIS_TRANSITION, FAST_TRANSITION } from "../lib/motion";
import type { MetricsPoint } from "../lib/models";

type TrendChartProps = {
  title: string;
  value?: string;
  numericValue?: number;
  valueFormatter?: (value: number) => string;
  series: MetricsPoint[];
  tone: "cyan" | "amber" | "emerald" | "rose";
  detail?: string;
};

const tones = {
  cyan: { stroke: "#7dd7ff", fill: "rgba(125, 215, 255, 0.22)" },
  amber: { stroke: "#f6be73", fill: "rgba(246, 190, 115, 0.22)" },
  emerald: { stroke: "#66e0c2", fill: "rgba(102, 224, 194, 0.22)" },
  rose: { stroke: "#ff9389", fill: "rgba(255, 147, 137, 0.22)" },
};

export const TrendChart = memo(function TrendChart({
  title,
  value,
  numericValue,
  valueFormatter,
  series,
  tone,
  detail,
}: TrendChartProps) {
  const { areaPath, linePath, lastPoint } = useMemo(() => buildPaths(series), [series]);
  const palette = tones[tone];
  const gradientId = useId().replace(/:/g, "");

  return (
    <article className={`surface trend-card trend-card-${tone}`}>
      <header>
        <div>
          <span className="chart-kicker">{title}</span>
          <strong>
            {numericValue !== undefined ? (
              <AnimatedNumber formatter={valueFormatter} value={numericValue} />
            ) : (
              value
            )}
          </strong>
        </div>
        {detail ? <small>{detail}</small> : null}
      </header>
      {series.length === 0 ? (
        <div className="chart-empty">Collecting live samples</div>
      ) : (
        <svg className="trend-svg" viewBox="0 0 320 150" preserveAspectRatio="none" role="img" aria-label={title}>
          <defs>
            <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={palette.fill} />
              <stop offset="100%" stopColor="rgba(255,255,255,0)" />
            </linearGradient>
          </defs>
          <motion.path
            animate={{ d: areaPath }}
            fill={`url(#${gradientId})`}
            initial={false}
            transition={EMPHASIS_TRANSITION}
          />
          <motion.path
            animate={{ d: linePath }}
            fill="none"
            initial={false}
            stroke={palette.stroke}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="3"
            transition={EMPHASIS_TRANSITION}
          />
          {lastPoint ? (
            <motion.circle
              animate={{ cx: lastPoint.x, cy: lastPoint.y, opacity: 1 }}
              className="trend-highlight"
              fill={palette.stroke}
              initial={false}
              r="4.5"
              transition={FAST_TRANSITION}
            />
          ) : null}
        </svg>
      )}
    </article>
  );
});

function buildPaths(series: MetricsPoint[]) {
  const width = 320;
  const baseline = 132;

  const values = series.map((point) => point.value);
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 1);
  const span = Math.max(max - min, 1);

  const points = series.map((point, index) => {
    const x = series.length === 1 ? width / 2 : (index / (series.length - 1)) * width;
    const y = baseline - ((point.value - min) / span) * 100;
    return { x, y };
  });

  const linePath = points.reduce(
    (path, point, index) => `${path}${index === 0 ? "M" : " L"}${point.x.toFixed(2)} ${point.y.toFixed(2)}`,
    "",
  );
  const areaPath = `${linePath} L ${width} ${baseline} L 0 ${baseline} Z`;

  return { areaPath, linePath, lastPoint: points.at(-1) ?? null };
}
