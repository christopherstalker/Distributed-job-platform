import { startTransition, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

import {
  parseDashboardSnapshot,
  parseJobInspection,
  parseJobs,
  parseSchedules,
  parseWorkerStatuses,
} from "../lib/api-parsers";
import {
  appendEvents,
  createEmptyConsoleData,
  createConsoleDataFromApi,
  createDemoConsoleData,
  getInspection,
  stabilizeConsoleData,
} from "../lib/console-data";
import { formatTransportMode, LiveTransportManager } from "../lib/live-transport";
import {
  createConsolePayloadSignature,
  createInspectionSignature,
  getDrawerRefreshInterval,
  getNextPollDelay,
} from "../lib/live-refresh";
import type {
  ConsoleData,
  DashboardSnapshot,
  Job,
  JobInspection,
  LiveHealth,
  PollingPreset,
  Schedule,
  SystemEvent,
  TransportMode,
  TransportStatus,
  WorkerStatus,
} from "../lib/models";
import { requestJson as performRequestJson } from "../lib/request-client";
import { formatRequestError, normalizeBaseUrl } from "../lib/safe";
import { API_ROUTES } from "../lib/api-routes";
import type { ToastInput } from "./useToastQueue";

type InspectionMeta = {
  busy: boolean;
  error: string;
  lastUpdatedAt: string;
};

type UseDashboardLiveDataOptions = {
  baseUrlInput: string;
  realtimeBaseUrlInput?: string;
  token: string;
  liveMode: boolean;
  liveUpdates: boolean;
  pollIntervalMs: PollingPreset;
  selectedJobId: string;
  notify: (toast: ToastInput) => void;
};

type RefreshOptions = {
  quiet?: boolean;
  force?: boolean;
};

type RequestParser<T> = (value: unknown) => T;

const EVENT_BATCH_WINDOW_MS = 180;
const CONSOLE_REFRESH_DEBOUNCE_MS = 320;
const INSPECTION_REFRESH_DEBOUNCE_MS = 450;
const MIN_POLLING_FALLBACK_MS = 15_000;

const initialTransportStatus: TransportStatus = {
  mode: "offline",
  state: "idle",
  attempt: 0,
  lastMessageAt: "",
  lastFailureAt: "",
  lastError: "",
  degradedReason: "",
  nextRetryAt: "",
};

export function useDashboardLiveData({
  baseUrlInput,
  realtimeBaseUrlInput,
  token,
  liveMode,
  liveUpdates,
  pollIntervalMs,
  selectedJobId,
  notify,
}: UseDashboardLiveDataOptions) {
  const [consoleData, setConsoleData] = useState<ConsoleData>(() =>
    liveMode ? createEmptyConsoleData("live") : createDemoConsoleData(),
  );
  const [inspectionCache, setInspectionCache] = useState<Record<string, JobInspection>>({});
  const [inspectionMeta, setInspectionMeta] = useState<Record<string, InspectionMeta>>({});
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [globalError, setGlobalError] = useState("");
  const [lastAttemptAt, setLastAttemptAt] = useState("");
  const [lastSuccessfulAt, setLastSuccessfulAt] = useState("");
  const [lastFetchAt, setLastFetchAt] = useState("");
  const [degradedSince, setDegradedSince] = useState("");
  const [consecutiveFailures, setConsecutiveFailures] = useState(0);
  const [currentPollDelayMs, setCurrentPollDelayMs] = useState(0);
  const [isVisible, setIsVisible] = useState(() =>
    typeof document === "undefined" ? true : document.visibilityState === "visible",
  );
  const [transportStatus, setTransportStatus] = useState<TransportStatus>(initialTransportStatus);

  const resolvedBaseUrl = useMemo(() => normalizeBaseUrl(baseUrlInput), [baseUrlInput]);
  const resolvedRealtimeBaseUrl = useMemo(
    () => normalizeBaseUrl(realtimeBaseUrlInput || baseUrlInput),
    [baseUrlInput, realtimeBaseUrlInput],
  );
  const emitToast = useEffectEvent((toast: ToastInput) => notify(toast));

  const consoleDataRef = useRef(consoleData);
  const inspectionCacheRef = useRef(inspectionCache);
  const selectedJobIdRef = useRef(selectedJobId);
  const dataSignatureRef = useRef("");
  const inspectionSignatureRef = useRef<Record<string, string>>({});
  const fetchPromiseRef = useRef<Promise<void> | null>(null);
  const fetchControllerRef = useRef<AbortController | null>(null);
  const requestMapRef = useRef(new Map<string, Promise<unknown>>());
  const inspectionPromiseRef = useRef<Record<string, Promise<void> | null>>({});
  const inspectionControllerRef = useRef<Record<string, AbortController | null>>({});
  const refreshDebounceRef = useRef<number | null>(null);
  const inspectionDebounceRef = useRef<Record<string, number>>({});
  const pendingEventsRef = useRef<SystemEvent[]>([]);
  const eventFlushTimerRef = useRef<number | null>(null);
  const transportManagerRef = useRef<LiveTransportManager | null>(null);
  const lastHealthRef = useRef<LiveHealth>("demo");
  const lastTransportModeRef = useRef<TransportMode>("demo");
  const lastSuccessfulAtRef = useRef(lastSuccessfulAt);
  const consecutiveFailuresRef = useRef(consecutiveFailures);
  const transportStatusRef = useRef(transportStatus);

  useEffect(() => {
    consoleDataRef.current = consoleData;
  }, [consoleData]);

  useEffect(() => {
    inspectionCacheRef.current = inspectionCache;
  }, [inspectionCache]);

  useEffect(() => {
    selectedJobIdRef.current = selectedJobId;
  }, [selectedJobId]);

  useEffect(() => {
    lastSuccessfulAtRef.current = lastSuccessfulAt;
  }, [lastSuccessfulAt]);

  useEffect(() => {
    consecutiveFailuresRef.current = consecutiveFailures;
  }, [consecutiveFailures]);

  useEffect(() => {
    transportStatusRef.current = transportStatus;
  }, [transportStatus]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      setIsVisible(document.visibilityState === "visible");
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  const updateTransportStatus = useEffectEvent((nextStatus: TransportStatus) => {
    transportStatusRef.current = nextStatus;
    setTransportStatus((current) => (sameTransportStatus(current, nextStatus) ? current : nextStatus));
  });

  const requestJson = useEffectEvent(async function requestJson<T>(
    path: string,
    init?: RequestInit,
    requestKey?: string,
    parser?: RequestParser<T>,
    allowEmpty = false,
  ): Promise<T> {
    const method = init?.method ?? "GET";
    const dedupeKey = requestKey ?? `${method}:${path}:${typeof init?.body === "string" ? init.body : ""}`;
    const existing = requestMapRef.current.get(dedupeKey);
    if (existing) {
      return existing as Promise<T>;
    }

    const request = performRequestJson<T>({
      baseUrl: resolvedBaseUrl,
      path,
      token,
      init,
      parser,
      allowEmpty,
    });

    requestMapRef.current.set(dedupeKey, request);
    try {
      return await request;
    } finally {
      requestMapRef.current.delete(dedupeKey);
    }
  });

  const applyInspectionFallback = useEffectEvent((jobId: string) => {
    const fallback = getInspection(
      {
        ...consoleDataRef.current,
        inspections: inspectionCacheRef.current,
      },
      jobId,
    );

    if (!fallback) {
      return;
    }

    const signature = createInspectionSignature(fallback);
    if (inspectionSignatureRef.current[jobId] === signature) {
      return;
    }

    inspectionSignatureRef.current[jobId] = signature;
    setInspectionCache((current) => ({ ...current, [jobId]: fallback }));
  });

  const refreshInspection = useEffectEvent(async (jobId: string, options: RefreshOptions = {}) => {
    if (!jobId) {
      return;
    }

    if (!liveMode || consoleDataRef.current.source !== "live") {
      applyInspectionFallback(jobId);
      setInspectionMeta((current) => ({
        ...current,
        [jobId]: {
          busy: false,
          error: "",
          lastUpdatedAt: current[jobId]?.lastUpdatedAt || new Date().toISOString(),
        },
      }));
      return;
    }

    if (inspectionPromiseRef.current[jobId] && !options.force) {
      return inspectionPromiseRef.current[jobId];
    }

    inspectionControllerRef.current[jobId]?.abort();
    const controller = new AbortController();
    inspectionControllerRef.current[jobId] = controller;

    setInspectionMeta((current) => ({
      ...current,
      [jobId]: {
        busy: true,
        error: "",
        lastUpdatedAt: current[jobId]?.lastUpdatedAt || "",
      },
    }));

    const previousSignature = inspectionSignatureRef.current[jobId];
    const promise = (async () => {
      try {
        const inspection = await requestJson<JobInspection>(
          API_ROUTES.jobInspection(jobId),
          { signal: controller.signal },
          `inspection:${jobId}`,
          parseJobInspection,
        );

        if (controller.signal.aborted) {
          return;
        }

        const signature = createInspectionSignature(inspection);
        const refreshedAt = new Date().toISOString();
        inspectionSignatureRef.current[jobId] = signature;

        if (signature !== previousSignature) {
          setInspectionCache((current) => ({ ...current, [jobId]: inspection }));
        }

        setInspectionMeta((current) => ({
          ...current,
          [jobId]: {
            busy: false,
            error: "",
            lastUpdatedAt: refreshedAt,
          },
        }));
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }

        applyInspectionFallback(jobId);
        setInspectionMeta((current) => ({
          ...current,
          [jobId]: {
            busy: false,
            error: formatRequestError(error),
            lastUpdatedAt: current[jobId]?.lastUpdatedAt || "",
          },
        }));
      } finally {
        if (inspectionControllerRef.current[jobId] === controller) {
          inspectionControllerRef.current[jobId] = null;
        }
        inspectionPromiseRef.current[jobId] = null;
      }
    })();

    inspectionPromiseRef.current[jobId] = promise;
    return promise;
  });

  const refreshConsole = useEffectEvent(async (options: RefreshOptions = {}) => {
    if (!liveMode) {
      return;
    }

    const quiet = Boolean(options.quiet);
    const attemptAt = new Date().toISOString();
    if (!quiet) {
      setLastAttemptAt(attemptAt);
    }

    if (!resolvedBaseUrl) {
      setLoading(false);
      if (!quiet) {
        setIsRefreshing(false);
      }
      setCurrentPollDelayMs(0);
      setGlobalError("API base URL is invalid. Live data is paused until the connection settings are corrected.");
      setTransportStatus((current) => ({
        ...current,
        mode: "offline",
        state: "offline",
        degradedReason: "API base URL is invalid.",
        lastError: "API base URL is invalid.",
      }));
      setConsecutiveFailures((current) => {
        const next = current === 0 ? 1 : current;
        consecutiveFailuresRef.current = next;
        return next;
      });
      return;
    }

    if (fetchPromiseRef.current && !options.force) {
      return fetchPromiseRef.current;
    }

    fetchControllerRef.current?.abort();
    const controller = new AbortController();
    fetchControllerRef.current = controller;

    if (!lastSuccessfulAt) {
      setLoading(true);
    } else if (!quiet) {
      setIsRefreshing(true);
    }

    const promise = (async () => {
      try {
        const [snapshot, jobs, schedules, workerStatuses] = await Promise.all([
          requestJson<DashboardSnapshot>(
            API_ROUTES.dashboardSnapshot,
            { signal: controller.signal },
            "dashboard-snapshot",
            parseDashboardSnapshot,
          ),
          requestJson<Job[]>(
            API_ROUTES.jobsWithLimit(120),
            { signal: controller.signal },
            "dashboard-jobs",
            parseJobs,
          ),
          requestJson<Schedule[]>(
            API_ROUTES.schedules,
            { signal: controller.signal },
            "dashboard-schedules",
            parseSchedules,
          ),
          requestJson<WorkerStatus[]>(
            API_ROUTES.workers,
            { signal: controller.signal },
            "dashboard-workers",
            parseWorkerStatuses,
          ),
        ]);

        if (controller.signal.aborted) {
          return;
        }

        const nextSignature = createConsolePayloadSignature({
          snapshot,
          jobs,
          schedules,
          workerStatuses,
        });
        const refreshedAt = new Date().toISOString();

        if (consoleDataRef.current.source !== "live" || nextSignature !== dataSignatureRef.current) {
          dataSignatureRef.current = nextSignature;
          startTransition(() => {
            setConsoleData((current) => {
              const next = stabilizeConsoleData(
                current,
                createConsoleDataFromApi({
                  snapshot,
                  jobs,
                  schedules,
                  workerStatuses,
                  events: current.source === "live" ? current.events : [],
                }),
              );
              return {
                ...next,
                inspections: current.inspections,
                queueControls: current.queueControls,
                workerControls: current.workerControls,
              };
            });
          });
        }

        lastSuccessfulAtRef.current = refreshedAt;
        setLastSuccessfulAt(refreshedAt);
        setLastFetchAt(refreshedAt);
        consecutiveFailuresRef.current = 0;
        setConsecutiveFailures(0);
        setGlobalError("");
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }

        setGlobalError(formatRequestError(error));
        setConsecutiveFailures((current) => {
          const next = current + 1;
          consecutiveFailuresRef.current = next;
          return next;
        });
      } finally {
        if (fetchControllerRef.current === controller) {
          fetchControllerRef.current = null;
        }
        fetchPromiseRef.current = null;
        setLoading(false);
        if (!quiet) {
          setIsRefreshing(false);
        }
      }
    })();

    fetchPromiseRef.current = promise;
    return promise;
  });

  const scheduleConsoleRefresh = useEffectEvent(() => {
    if (refreshDebounceRef.current !== null) {
      window.clearTimeout(refreshDebounceRef.current);
    }
    refreshDebounceRef.current = window.setTimeout(() => {
      void refreshConsole({ quiet: true });
    }, CONSOLE_REFRESH_DEBOUNCE_MS);
  });

  const flushPendingEvents = useEffectEvent(() => {
    if (eventFlushTimerRef.current !== null) {
      window.clearTimeout(eventFlushTimerRef.current);
      eventFlushTimerRef.current = null;
    }

    if (pendingEventsRef.current.length === 0) {
      return;
    }

    const queuedEvents = pendingEventsRef.current;
    pendingEventsRef.current = [];

    startTransition(() => {
      setConsoleData((current) => appendEvents(current, queuedEvents));
    });

    scheduleConsoleRefresh();
  });

  const queueLiveEvent = useEffectEvent((event: SystemEvent) => {
    pendingEventsRef.current.push(event);

    if (eventFlushTimerRef.current !== null) {
      return;
    }

    eventFlushTimerRef.current = window.setTimeout(() => {
      flushPendingEvents();
    }, EVENT_BATCH_WINDOW_MS);
  });

  const scheduleInspectionRefresh = useEffectEvent((jobId: string) => {
    if (!jobId) {
      return;
    }

    const existing = inspectionDebounceRef.current[jobId];
    if (existing) {
      window.clearTimeout(existing);
    }

    inspectionDebounceRef.current[jobId] = window.setTimeout(() => {
      delete inspectionDebounceRef.current[jobId];
      void refreshInspection(jobId, { quiet: true });
    }, INSPECTION_REFRESH_DEBOUNCE_MS);
  });

  const manualReconnect = useEffectEvent(() => {
    if (!liveMode) {
      return;
    }
    transportManagerRef.current?.retryNow();
    void refreshConsole({ quiet: true, force: true });
  });

  useEffect(() => {
    fetchControllerRef.current?.abort();
    Object.values(inspectionControllerRef.current).forEach((controller) => controller?.abort());
    transportManagerRef.current?.stop(liveMode ? "idle" : "demo");
    transportManagerRef.current = null;
    dataSignatureRef.current = "";
    inspectionSignatureRef.current = {};
    lastSuccessfulAtRef.current = "";
    consecutiveFailuresRef.current = 0;
    transportStatusRef.current = liveMode
      ? initialTransportStatus
      : {
          ...initialTransportStatus,
          mode: "demo",
          state: "demo",
        };
    setCurrentPollDelayMs(0);
    setGlobalError("");
    setConsecutiveFailures(0);
    setDegradedSince("");
    setLastAttemptAt("");
    setLastSuccessfulAt("");
    setLastFetchAt("");
    setIsRefreshing(false);
    setInspectionCache({});
    setInspectionMeta({});
    pendingEventsRef.current = [];
    if (refreshDebounceRef.current !== null) {
      window.clearTimeout(refreshDebounceRef.current);
      refreshDebounceRef.current = null;
    }
    Object.values(inspectionDebounceRef.current).forEach((timer) => window.clearTimeout(timer));
    inspectionDebounceRef.current = {};
    if (eventFlushTimerRef.current !== null) {
      window.clearTimeout(eventFlushTimerRef.current);
      eventFlushTimerRef.current = null;
    }

    if (!liveMode) {
      setTransportStatus({
        ...initialTransportStatus,
        mode: "demo",
        state: "demo",
      });
      setLoading(false);
      lastHealthRef.current = "demo";
      lastTransportModeRef.current = "demo";
      setConsoleData((current) => (current.source === "demo" ? current : createDemoConsoleData()));
      return;
    }

    setTransportStatus(initialTransportStatus);
    setLoading(true);
    setConsoleData(createEmptyConsoleData("live"));
  }, [liveMode]);

  useEffect(() => {
    transportManagerRef.current?.stop(isVisible ? "polling" : "paused");
    transportManagerRef.current = null;

    if (!liveMode) {
      return;
    }

    if (!resolvedBaseUrl) {
      setTransportStatus({
        ...initialTransportStatus,
        mode: "offline",
        state: "offline",
        degradedReason: "API base URL is invalid.",
        lastError: "API base URL is invalid.",
      });
      return;
    }

    if (!isVisible) {
      setTransportStatus((current) => ({
        ...current,
        state: "paused",
        attempt: 0,
        nextRetryAt: "",
      }));
      return;
    }

    if (!liveUpdates) {
      setTransportStatus((current) => ({
        ...current,
        mode: pollIntervalMs > 0 ? "polling" : "offline",
        state: pollIntervalMs > 0 ? "polling" : "paused",
        attempt: 0,
        nextRetryAt: "",
        degradedReason: "",
        lastError: "",
      }));
      return;
    }

    const manager = new LiveTransportManager({
      baseUrl: resolvedRealtimeBaseUrl || resolvedBaseUrl,
      token,
      onEvent: (event) => {
        queueLiveEvent(event);
        if (event.jobId && event.jobId === selectedJobIdRef.current) {
          scheduleInspectionRefresh(event.jobId);
        }
      },
      onMalformedMessage: () => {
        setTransportStatus((current) => ({
          ...current,
          lastError: "Ignored a malformed realtime message.",
          lastFailureAt: new Date().toISOString(),
        }));
      },
      onStatus: updateTransportStatus,
    });

    transportManagerRef.current = manager;
    manager.start();

    return () => {
      manager.stop(isVisible ? "polling" : "paused");
      if (transportManagerRef.current === manager) {
        transportManagerRef.current = null;
      }
    };
  }, [isVisible, liveMode, liveUpdates, pollIntervalMs, resolvedBaseUrl, resolvedRealtimeBaseUrl, token]);

  useEffect(() => {
    if (!liveMode) {
      return;
    }

    if (!resolvedBaseUrl) {
      setCurrentPollDelayMs(0);
      void refreshConsole({ quiet: true });
      return;
    }

    if (!isVisible) {
      setCurrentPollDelayMs(0);
      return;
    }

    let cancelled = false;
    let timer: number | null = null;

    const scheduleNext = () => {
      const baseDelay = getNextPollDelay(pollIntervalMs, consecutiveFailuresRef.current);
      if (baseDelay === null) {
        setCurrentPollDelayMs(0);
        return;
      }

      const usingRealtime = liveUpdates && ["websocket", "sse"].includes(transportStatusRef.current.mode);
      const nextDelay = usingRealtime ? baseDelay : Math.max(baseDelay, MIN_POLLING_FALLBACK_MS);
      setCurrentPollDelayMs(nextDelay);
      timer = window.setTimeout(() => {
        void run(true);
      }, nextDelay);
    };

    const run = async (quiet: boolean) => {
      await refreshConsole({ quiet });

      if (cancelled || !isVisible || !resolvedBaseUrl) {
        return;
      }

      scheduleNext();
    };

    void run(Boolean(lastSuccessfulAtRef.current));

    return () => {
      cancelled = true;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [
    isVisible,
    liveMode,
    liveUpdates,
    pollIntervalMs,
    resolvedBaseUrl,
    transportStatus.mode,
  ]);

  useEffect(() => {
    if (!selectedJobId) {
      return;
    }

    void refreshInspection(selectedJobId, { quiet: true });
  }, [selectedJobId]);

  useEffect(() => {
    if (!selectedJobId || !liveMode || !isVisible) {
      return;
    }

    const refreshInterval = getDrawerRefreshInterval(pollIntervalMs);
    if (refreshInterval <= 0) {
      return;
    }

    const timer = window.setInterval(() => {
      void refreshInspection(selectedJobId, { quiet: true });
    }, refreshInterval);

    return () => {
      window.clearInterval(timer);
    };
  }, [isVisible, liveMode, pollIntervalMs, selectedJobId]);

  useEffect(() => {
    if (!selectedJobId) {
      return;
    }

    setInspectionCache((current) => {
      const existing = current[selectedJobId];
      const latestJob = consoleData.jobs.find((job) => job.id === selectedJobId);
      if (!existing || !latestJob) {
        return current;
      }
      if (existing.job.updatedAt === latestJob.updatedAt && existing.job.state === latestJob.state) {
        return current;
      }
      return {
        ...current,
        [selectedJobId]: {
          ...existing,
          job: latestJob,
          deadLetter:
            existing.deadLetter && existing.deadLetter.job?.id === latestJob.id
              ? { ...existing.deadLetter, job: latestJob }
              : existing.deadLetter,
        },
      };
    });
  }, [consoleData.jobs, selectedJobId]);

  const transportMode = useMemo(() => {
    if (!liveMode) {
      return "demo";
    }
    if (!resolvedBaseUrl) {
      return "offline";
    }
    if (liveUpdates && transportStatus.mode === "websocket" && transportStatus.state === "live") {
      return "websocket";
    }
    if (liveUpdates && transportStatus.mode === "sse" && transportStatus.state === "live") {
      return "sse";
    }
    if (pollIntervalMs > 0) {
      if (consecutiveFailures > 0 && !lastSuccessfulAt) {
        return "offline";
      }
      return "polling";
    }
    return consecutiveFailures > 0 ? "degraded" : "offline";
  }, [
    consecutiveFailures,
    lastSuccessfulAt,
    liveMode,
    liveUpdates,
    pollIntervalMs,
    resolvedBaseUrl,
    transportStatus.mode,
    transportStatus.state,
  ]);

  const liveHealth: LiveHealth = useMemo(() => {
    if (!liveMode) {
      return "demo";
    }
    if (!resolvedBaseUrl) {
      return "offline";
    }
    if (pollIntervalMs <= 0 && !liveUpdates) {
      return "paused";
    }
    if (consecutiveFailures > 0) {
      return lastSuccessfulAt ? "degraded" : "offline";
    }
    if (liveUpdates && transportStatus.state === "connecting" && lastSuccessfulAt) {
      return "reconnecting";
    }
    if (liveUpdates && transportMode === "polling") {
      return "degraded";
    }
    return "live";
  }, [
    consecutiveFailures,
    lastSuccessfulAt,
    liveMode,
    liveUpdates,
    pollIntervalMs,
    resolvedBaseUrl,
    transportMode,
    transportStatus.state,
  ]);

  const hasLiveData = useMemo(
    () => liveMode && consoleData.source === "live" && Boolean(consoleData.lastHydratedAt),
    [consoleData.lastHydratedAt, consoleData.source, liveMode],
  );

  useEffect(() => {
    const degraded = ["degraded", "offline", "reconnecting"].includes(liveHealth);
    if (degraded) {
      setDegradedSince((current) => current || transportStatus.lastFailureAt || new Date().toISOString());
      return;
    }
    setDegradedSince("");
  }, [liveHealth, transportStatus.lastFailureAt]);

  useEffect(() => {
    const previousHealth = lastHealthRef.current;
    const previousMode = lastTransportModeRef.current;
    const recovered =
      ["degraded", "offline", "reconnecting"].includes(previousHealth) &&
      ["websocket", "sse"].includes(transportMode) &&
      liveHealth === "live" &&
      Boolean(lastSuccessfulAt);

    if (recovered && (previousMode !== transportMode || previousHealth !== liveHealth)) {
      emitToast({
        key: "live-recovered",
        tone: "success",
        title: "Realtime transport recovered",
        description: `${formatTransportMode(transportMode)} is healthy again and the dashboard kept its last good data.`,
        cooldownMs: 10_000,
      });
    }

    lastHealthRef.current = liveHealth;
    lastTransportModeRef.current = transportMode;
  }, [lastSuccessfulAt, liveHealth, transportMode]);

  useEffect(() => {
    return () => {
      fetchControllerRef.current?.abort();
      Object.values(inspectionControllerRef.current).forEach((controller) => controller?.abort());
      if (refreshDebounceRef.current !== null) {
        window.clearTimeout(refreshDebounceRef.current);
      }
      Object.values(inspectionDebounceRef.current).forEach((timer) => window.clearTimeout(timer));
      if (eventFlushTimerRef.current !== null) {
        window.clearTimeout(eventFlushTimerRef.current);
      }
      transportManagerRef.current?.stop();
    };
  }, []);

  const selectedInspection = useMemo(() => {
    if (!selectedJobId) {
      return null;
    }

    const cached = inspectionCache[selectedJobId];
    if (cached) {
      const latestJob = consoleData.jobs.find((job) => job.id === selectedJobId);
      if (!latestJob) {
        return cached;
      }
      return {
        ...cached,
        job: latestJob,
        deadLetter:
          cached.deadLetter && cached.deadLetter.job?.id === latestJob.id
            ? { ...cached.deadLetter, job: latestJob }
            : cached.deadLetter,
      };
    }

    return getInspection(
      {
        ...consoleData,
        inspections: inspectionCache,
      },
      selectedJobId,
    );
  }, [consoleData, inspectionCache, selectedJobId]);

  return {
    consoleData,
    setConsoleData,
    requestJson,
    refreshConsole,
    refreshInspection,
    manualReconnect,
    selectedInspection,
    selectedInspectionMeta: selectedJobId
      ? inspectionMeta[selectedJobId] ?? { busy: false, error: "", lastUpdatedAt: "" }
      : { busy: false, error: "", lastUpdatedAt: "" },
    loading,
    isRefreshing,
    globalError,
    resolvedBaseUrl,
    liveMeta: {
      health: liveHealth,
      transportMode,
      transportLabel: formatTransportMode(transportMode),
      connectionState: transportStatus.state,
      isVisible,
      lastAttemptAt,
      lastSuccessfulAt,
      lastFetchAt,
      lastMessageAt: transportStatus.lastMessageAt,
      degradedSince,
      degradedReason: transportStatus.degradedReason || globalError,
      consecutiveFailures,
      reconnectAttempt: transportStatus.attempt,
      currentPollDelayMs,
      nextRetryAt: transportStatus.nextRetryAt,
      hasLiveData,
      dataStale: liveHealth === "degraded" || liveHealth === "offline" || liveHealth === "reconnecting",
    },
  };
}

function sameTransportStatus(left: TransportStatus, right: TransportStatus) {
  return (
    left.mode === right.mode &&
    left.state === right.state &&
    left.attempt === right.attempt &&
    left.lastMessageAt === right.lastMessageAt &&
    left.lastFailureAt === right.lastFailureAt &&
    left.lastError === right.lastError &&
    left.degradedReason === right.degradedReason &&
    left.nextRetryAt === right.nextRetryAt
  );
}
