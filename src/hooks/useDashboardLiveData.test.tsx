import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useDashboardLiveData } from "./useDashboardLiveData";
import { API_ROUTES } from "../lib/api-routes";

const requestJsonMock = vi.fn();

vi.mock("../lib/request-client", () => ({
  requestJson: (options: unknown) => requestJsonMock(options),
}));

vi.mock("../lib/live-transport", () => ({
  formatTransportMode: (mode: string) => mode,
  LiveTransportManager: class LiveTransportManager {
    start() {
      return undefined;
    }

    stop() {
      return undefined;
    }

    retryNow() {
      return undefined;
    }
  },
}));

const snapshotResponse = {
  overview: {
    totalJobs: 0,
    queuedJobs: 0,
    blockedJobs: 0,
    throttledJobs: 0,
    activeJobs: 0,
    failedJobs: 0,
    retryingJobs: 0,
    completedJobs: 0,
    scheduledJobs: 0,
    canceledJobs: 0,
    queueLengths: { critical: 0, default: 0, low: 0 },
    averageExecMs: 0,
    lastUpdatedAt: "2026-03-12T20:00:00Z",
    activeWorkers: 0,
    delayedBacklog: 0,
  },
  metrics: {
    jobsPerSecond: 0,
    retryRate: 0,
    deadLetterRate: 0,
    executionLatency: { p50Ms: 0, p95Ms: 0, p99Ms: 0 },
    queueLatency: { p50Ms: 0, p95Ms: 0, p99Ms: 0 },
    maxWorkerHeartbeatAgeMs: 0,
  },
  trend: {
    throughput: [],
    executionP95Ms: [],
    queueLatencyP95Ms: [],
    retryRate: [],
    deadLetterRate: [],
  },
  workers: [],
  deadLetters: [],
  blockedJobs: [],
  throttledJobs: [],
  rateLimits: [],
  leader: {},
};

const jobsResponse: unknown[] = [];
const schedulesResponse: unknown[] = [];
const workersResponse: unknown[] = [];

describe("useDashboardLiveData", () => {
  beforeEach(() => {
    requestJsonMock.mockReset();
    window.localStorage.clear();
  });

  afterEach(() => {
    requestJsonMock.mockReset();
  });

  it("does not immediately restart polling after a successful fetch", async () => {
    requestJsonMock.mockImplementation(async ({ path, parser }: { path: string; parser?: (value: unknown) => unknown }) => {
      const value =
        path === API_ROUTES.dashboardSnapshot
          ? snapshotResponse
          : path === API_ROUTES.jobsWithLimit(120)
            ? jobsResponse
            : path === API_ROUTES.schedules
              ? schedulesResponse
              : workersResponse;
      return parser ? parser(value) : value;
    });

    renderHook(() =>
      useDashboardLiveData({
        baseUrlInput: "http://localhost:8080",
        token: "dev-admin-token",
        liveMode: true,
        liveUpdates: false,
        pollIntervalMs: 0,
        selectedJobId: "",
        notify: vi.fn(),
      }),
    );

    await waitFor(() => expect(requestJsonMock).toHaveBeenCalledTimes(4));
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 10));
    expect(requestJsonMock).toHaveBeenCalledTimes(4);
  });

  it("keeps live mode empty instead of falling back to demo data when the first refresh fails", async () => {
    requestJsonMock.mockRejectedValue(new Error("Network unavailable"));

    const { result } = renderHook(() =>
      useDashboardLiveData({
        baseUrlInput: "http://localhost:8080",
        token: "dev-admin-token",
        liveMode: true,
        liveUpdates: false,
        pollIntervalMs: 0,
        selectedJobId: "",
        notify: vi.fn(),
      }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.consoleData.source).toBe("live");
    expect(result.current.consoleData.jobs).toEqual([]);
    expect(result.current.liveMeta.hasLiveData).toBe(false);
  });
});
