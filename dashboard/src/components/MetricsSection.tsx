import { memo, useMemo } from "react";

import { MetricTile, SectionHeader } from "./ConsolePrimitives";
import { TrendChart } from "./TrendChart";
import type { DashboardSnapshot, QueueView } from "../lib/models";
import { formatLatency, formatRate } from "../lib/safe";

export const MetricsSection = memo(function MetricsSection({
  snapshot,
  queueViews,
}: {
  snapshot: DashboardSnapshot;
  queueViews: QueueView[];
}) {
  const backlogSummary = useMemo(
    () => ({
      backlog: queueViews.reduce((total, item) => total + item.backlog, 0),
      saturatedQueues: queueViews.filter((queue) => queue.saturation >= 80).length,
    }),
    [queueViews],
  );

  return (
    <section className="surface">
      <SectionHeader title="Metrics" detail="Latency, retry pressure, throughput, and backlog trend." />
      <div className="chart-grid">
        <TrendChart
          title="Processing latency"
          numericValue={snapshot.metrics.executionLatency.p95Ms}
          series={snapshot.trend.executionP95Ms}
          tone="amber"
          detail={`p50 ${formatLatency(snapshot.metrics.executionLatency.p50Ms)} / p99 ${formatLatency(snapshot.metrics.executionLatency.p99Ms)}`}
          valueFormatter={formatLatency}
        />
        <TrendChart
          title="Retry rate"
          numericValue={snapshot.metrics.retryRate}
          series={snapshot.trend.retryRate}
          tone="rose"
          detail={snapshot.metrics.retryRate > 1.5 ? "storm risk" : "nominal"}
          valueFormatter={formatRate}
        />
        <TrendChart
          title="Backlog trend proxy"
          numericValue={queueViews.reduce((total, item) => total + item.backlog, 0)}
          series={queueViews.map((queue, index) => ({ timestamp: `${index}`, value: queue.backlog }))}
          tone="emerald"
          detail="Derived from live queue depths"
        />
      </div>
      <div className="metric-strip">
        <MetricTile
          label="Queue p95"
          numericValue={snapshot.metrics.queueLatency.p95Ms}
          detail={`p99 ${formatLatency(snapshot.metrics.queueLatency.p99Ms)}`}
          tone="amber"
          valueFormatter={formatLatency}
        />
        <MetricTile
          label="Execution p95"
          numericValue={snapshot.metrics.executionLatency.p95Ms}
          detail={`p50 ${formatLatency(snapshot.metrics.executionLatency.p50Ms)}`}
          tone="amber"
          valueFormatter={formatLatency}
        />
        <MetricTile
          label="Heartbeat age"
          numericValue={snapshot.metrics.maxWorkerHeartbeatAgeMs}
          detail="max observed worker heartbeat age"
          tone="cyan"
          valueFormatter={formatLatency}
        />
        <MetricTile
          label="Queue backlog"
          numericValue={backlogSummary.backlog}
          detail={`${backlogSummary.saturatedQueues} queues above 80% saturation`}
          tone="emerald"
        />
      </div>
    </section>
  );
});
