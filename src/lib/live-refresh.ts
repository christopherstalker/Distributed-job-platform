import type {
  DashboardSnapshot,
  Job,
  JobInspection,
  LiveHealth,
  PollingPreset,
  Schedule,
  SystemEvent,
  WorkerStatus,
} from "./models";

export const POLLING_PRESETS: { label: string; value: PollingPreset }[] = [
  { label: "Paused", value: 0 },
  { label: "5s", value: 5_000 },
  { label: "15s", value: 15_000 },
  { label: "30s", value: 30_000 },
];

export function stableSerialize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function createConsolePayloadSignature(input: {
  snapshot: DashboardSnapshot;
  jobs: Job[];
  schedules: Schedule[];
  workerStatuses: WorkerStatus[];
}) {
  return stableSerialize(input);
}

export function createInspectionSignature(inspection: JobInspection) {
  return stableSerialize(inspection);
}

export function createEventFingerprint(event: SystemEvent) {
  return [
    event.kind,
    event.timestamp,
    event.jobId ?? "",
    event.queue ?? "",
    event.workerId ?? "",
    event.state ?? "",
    event.message ?? "",
  ].join("|");
}

export function getNextPollDelay(baseIntervalMs: number, consecutiveFailures: number) {
  if (baseIntervalMs <= 0) {
    return null;
  }

  if (consecutiveFailures <= 0) {
    return baseIntervalMs;
  }

  const multiplier = Math.min(2 ** consecutiveFailures, 8);
  return Math.min(baseIntervalMs * multiplier, 60_000);
}

export function getDrawerRefreshInterval(baseIntervalMs: number) {
  if (baseIntervalMs <= 0) {
    return 0;
  }
  return Math.max(baseIntervalMs * 2, 15_000);
}

export function resolveLiveHealth(input: {
  liveMode: boolean;
  pollIntervalMs: number;
  liveUpdates: boolean;
  hasLiveData: boolean;
  resolvedBaseUrl: string | null;
  consecutiveFailures: number;
  socketConnected: boolean;
  socketDesired: boolean;
}): LiveHealth {
  if (!input.liveMode) {
    return "demo";
  }
  if (!input.resolvedBaseUrl) {
    return "offline";
  }
  if (input.pollIntervalMs <= 0 && !input.liveUpdates) {
    return "paused";
  }
  if (input.consecutiveFailures > 0) {
    return input.hasLiveData ? "degraded" : "offline";
  }
  if (input.socketDesired && !input.socketConnected && input.hasLiveData) {
    return "reconnecting";
  }
  return "live";
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.keys(value as Record<string, unknown>)
    .sort()
    .reduce<Record<string, unknown>>((result, key) => {
      result[key] = sortValue((value as Record<string, unknown>)[key]);
      return result;
    }, {});
}
