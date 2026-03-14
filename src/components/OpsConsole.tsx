import {
  useCallback,
  FormEvent,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
} from "react";

import { AnimatePresence, motion } from "framer-motion";

import { SectionHeader, StatusPill } from "./ConsolePrimitives";
import { DeadLetterSection } from "./DeadLetterSection";
import { EventsSection } from "./EventsSection";
import { JobDrawer } from "./JobDrawer";
import { JobsSection } from "./JobsSection";
import { LoadingSkeleton } from "./LoadingSkeleton";
import { MetricsSection } from "./MetricsSection";
import { OperationsHero } from "./OperationsHero";
import { OverviewSection } from "./OverviewSection";
import { QueuesSection } from "./QueuesSection";
import { SchedulesSection } from "./SchedulesSection";
import { SideRail } from "./SideRail";
import { ToastViewport } from "./ToastViewport";
import { WorkersSection } from "./WorkersSection";
import { WorkflowsSection } from "./WorkflowsSection";
import { useDashboardLiveData } from "../hooks/useDashboardLiveData";
import { usePersistentState } from "../hooks/usePersistentState";
import { useQueryParamState } from "../hooks/useQueryParamState";
import { useToastQueue } from "../hooks/useToastQueue";
import {
  parseEnqueueResult,
  parseJob,
  parseJobs,
  parseSchedule,
} from "../lib/api-parsers";
import {
  addLocalWorkflowJobs,
  appendEvent,
  findDeadLetter,
  reconcileConsoleData,
  removeDeadLetters,
  replaceJob,
} from "../lib/console-data";
import { POLLING_PRESETS } from "../lib/live-refresh";
import { FAST_TRANSITION, LAYOUT_SPRING } from "../lib/motion";
import type {
  EnqueueResult,
  Job,
  JobDraft,
  PollingPreset,
  QueueView,
  Schedule,
  ScheduleDraft,
  WorkerView,
} from "../lib/models";
import {
  autofillGuardProps,
  clamp,
  createJobFromDraft,
  createToastId,
  credentialGuardProps,
  formatRelative,
  friendlyInlineError,
  looksLikeAutofillError,
  makeSystemEvent,
  parseDependencyIds,
  QUEUES,
  safeJsonParse,
  safeTrim,
  STORAGE_KEYS,
  stringifyJson,
  TABS,
} from "../lib/safe";
import {
  resolveDefaultAdminToken,
  resolveDefaultApiBaseUrl,
  resolveDefaultRealtimeBaseUrl,
} from "../lib/runtime-config";
import { API_ROUTES } from "../lib/api-routes";

const defaultBaseUrl = resolveDefaultApiBaseUrl();
const defaultToken = resolveDefaultAdminToken();

const defaultJobDraft: JobDraft = {
  type: "email.send",
  queue: "default",
  tenantId: "tenant-a",
  priority: "5",
  maxAttempts: "5",
  timeoutSeconds: "45",
  delaySeconds: "0",
  scheduledAt: "",
  workflowId: "",
  dependencies: "",
  idempotencyKey: "",
  dedupeWindowSeconds: "900",
  payload: '{\n  "recipient": "ops@example.com",\n  "durationMs": 250\n}',
};

const defaultScheduleDraft: ScheduleDraft = {
  name: "",
  cronExpression: "*/15 * * * *",
  queue: "default",
  type: "cleanup.run",
  priority: "5",
  maxAttempts: "5",
  timeoutSeconds: "60",
  timezone: "UTC",
  enabled: true,
  payload: '{\n  "resource": "stale-cache"\n}',
};

export default function OpsConsole() {
  const [environment, setEnvironment] = usePersistentState(STORAGE_KEYS.environment, "Demo Sandbox");
  const [baseUrlInput, setBaseUrlInput] = usePersistentState(STORAGE_KEYS.baseUrl, defaultBaseUrl);
  const realtimeBaseUrlInput = useMemo(
    () => resolveDefaultRealtimeBaseUrl(baseUrlInput),
    [baseUrlInput],
  );
  const [token, setToken] = usePersistentState(STORAGE_KEYS.token, defaultToken);
  const [liveMode, setLiveMode] = usePersistentState<boolean>(STORAGE_KEYS.liveMode, true, {
    deserialize: (raw) => raw !== "false",
    serialize: (value) => String(value),
  });
  const [liveUpdates, setLiveUpdates] = usePersistentState<boolean>(STORAGE_KEYS.liveUpdates, true, {
    deserialize: (raw) => raw !== "false",
    serialize: (value) => String(value),
  });
  const [pollIntervalMs, setPollIntervalMs] = usePersistentState<PollingPreset>(
    STORAGE_KEYS.pollIntervalMs,
    15_000,
    {
      deserialize: (raw) => {
        const value = Number(raw);
        return POLLING_PRESETS.some((preset) => preset.value === value) ? (value as PollingPreset) : 15_000;
      },
      serialize: (value) => String(value),
    },
  );

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tokenVisible, setTokenVisible] = useState(false);
  const [busyMap, setBusyMap] = useState<Record<string, boolean>>({});
  const [searchQuery, setSearchQuery] = useState("");
  const deferredSearch = useDeferredValue(searchQuery);

  const [selectedTab, setSelectedTab] = useQueryParamState("tab", "overview");
  const [selectedJobId, setSelectedJobId] = useQueryParamState("job", "");

  const [jobFilters, setJobFilters] = useState({ state: "all", queue: "all", sort: "updated", tenant: "" });
  const [deadLetterFilters, setDeadLetterFilters] = useState({ queue: "all", errorType: "all", search: "" });
  const [workerFilter, setWorkerFilter] = useState("");
  const [scheduleFilter, setScheduleFilter] = useState("");
  const [eventFilter, setEventFilter] = useState("");

  const [selectedDeadLetters, setSelectedDeadLetters] = useState<string[]>([]);
  const [bulkReplayQueue, setBulkReplayQueue] = useState("default");
  const [bulkReplayPayload, setBulkReplayPayload] = useState("");
  const [jobDraft, setJobDraft] = useState<JobDraft>(defaultJobDraft);
  const [jobFormErrors, setJobFormErrors] = useState<Record<string, string>>({});
  const [scheduleDraft, setScheduleDraft] = useState<ScheduleDraft>(defaultScheduleDraft);
  const [scheduleErrors, setScheduleErrors] = useState<Record<string, string>>({});

  const { toasts, enqueueToast, dismissToast } = useToastQueue();
  const {
    consoleData,
    setConsoleData,
    requestJson,
    refreshConsole,
    manualReconnect,
    selectedInspection,
    selectedInspectionMeta,
    loading,
    globalError,
    liveMeta,
  } = useDashboardLiveData({
    baseUrlInput,
    realtimeBaseUrlInput,
    token,
    liveMode,
    liveUpdates,
    pollIntervalMs,
    selectedJobId,
    notify: enqueueToast,
  });

  const tabKey = TABS.some((tab) => tab.key === selectedTab) ? selectedTab : "overview";
  const search = safeTrim(deferredSearch).toLowerCase();
  const demoMode = !liveMode;
  const priorityControlDetail =
    "Priority changes are demo-only because the live API does not expose a priority mutation endpoint.";
  const queueControlDetail =
    "Queue pause, resume, and drain are demo-only until the API exposes queue administration endpoints.";
  const workerControlDetail =
    "Worker cordon is demo-only until the backend exposes maintenance controls.";

  useEffect(() => {
    if (tabKey !== selectedTab) {
      setSelectedTab(tabKey);
    }
  }, [selectedTab, setSelectedTab, tabKey]);

  useEffect(() => {
    if (selectedJobId && !consoleData.jobs.some((job) => job.id === selectedJobId)) {
      setSelectedJobId("");
    }
  }, [consoleData.jobs, selectedJobId, setSelectedJobId]);

  useEffect(() => {
    setSelectedDeadLetters((current) => current.filter((jobId) => consoleData.snapshot.deadLetters.some((item) => item.jobId === jobId)));
  }, [consoleData.snapshot.deadLetters]);

  useEffect(() => {
    const handleError = (event: ErrorEvent) => {
      if (!looksLikeAutofillError(event.error ?? event.message)) {
        return;
      }
      event.preventDefault();
    };
    const handleRejection = (event: PromiseRejectionEvent) => {
      if (!looksLikeAutofillError(event.reason)) {
        return;
      }
      event.preventDefault();
    };
    window.addEventListener("error", handleError);
    window.addEventListener("unhandledrejection", handleRejection);
    return () => {
      window.removeEventListener("error", handleError);
      window.removeEventListener("unhandledrejection", handleRejection);
    };
  }, []);

  const setBusy = useCallback((key: string, value: boolean) => {
    setBusyMap((current) => {
      const next = { ...current };
      if (value) next[key] = true;
      else delete next[key];
      return next;
    });
  }, []);

  const runBusy = useCallback(async (key: string, task: () => Promise<void>) => {
    setBusy(key, true);
    try {
      await task();
    } finally {
      setBusy(key, false);
    }
  }, [setBusy]);

  const notifyUnsupportedLiveControl = useCallback((title: string, description: string) => {
    enqueueToast({
      key: `unsupported-live-control:${title}`,
      tone: "info",
      title,
      description,
      cooldownMs: 8_000,
    });
  }, [enqueueToast]);

  const updateJobDraft = useCallback((field: keyof JobDraft, value: string) => {
    setJobDraft((current) => ({ ...current, [field]: value }));
    setJobFormErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  }, []);

  const updateScheduleDraft = useCallback(<K extends keyof ScheduleDraft>(field: K, value: ScheduleDraft[K]) => {
    setScheduleDraft((current) => ({ ...current, [field]: value }));
    setScheduleErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  }, []);

  function resetConnectionSettings() {
    setBaseUrlInput(defaultBaseUrl);
    setToken(defaultToken);
    setLiveMode(true);
    setLiveUpdates(true);
    enqueueToast({
      key: "connection-settings-reset",
      tone: "info",
      title: "Connection settings reset",
      description: `Restored the default API endpoint${defaultToken ? " and token" : ""}.`,
    });
  }

  function validateJobForm() {
    const errors: Record<string, string> = {};
    const payloadResult = safeJsonParse(jobDraft.payload);
    if (!safeTrim(jobDraft.type)) errors.type = "Job type is required.";
    if (!safeTrim(jobDraft.tenantId)) errors.tenantId = "Tenant is required.";
    if (payloadResult.error) errors.payload = friendlyInlineError("payload", payloadResult.error);
    if (Number(jobDraft.priority) < 0 || Number(jobDraft.priority) > 9) errors.priority = "Priority must stay between 0 and 9.";
    if (safeTrim(jobDraft.scheduledAt)) {
      const scheduledTime = new Date(jobDraft.scheduledAt);
      if (Number.isNaN(scheduledTime.getTime()) || scheduledTime.getTime() <= Date.now()) {
        errors.scheduledAt = friendlyInlineError("scheduledAt", "scheduledAt");
      }
    }
    return {
      errors,
      payload: payloadResult.value,
      dedupeWindowSeconds: clamp(Number(jobDraft.dedupeWindowSeconds) || 0, 0, 86_400),
      dependencies: parseDependencyIds(jobDraft.dependencies),
    };
  }

  function validateScheduleForm() {
    const errors: Record<string, string> = {};
    const payloadResult = safeJsonParse(scheduleDraft.payload);
    if (!safeTrim(scheduleDraft.name)) errors.name = "Schedule name is required.";
    if (safeTrim(scheduleDraft.cronExpression).split(/\s+/).filter(Boolean).length < 5) errors.cronExpression = friendlyInlineError("cronExpression", "cronExpression");
    if (!safeTrim(scheduleDraft.type)) errors.type = "Job type is required.";
    if (payloadResult.error) errors.payload = friendlyInlineError("payload", payloadResult.error);
    return { errors, payload: payloadResult.value };
  }

  async function submitJob(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const validation = validateJobForm();
    if (Object.keys(validation.errors).length > 0 || !validation.payload) {
      setJobFormErrors(validation.errors);
      enqueueToast({ tone: "warning", title: "Job submission needs attention", description: "Fix the inline field errors before enqueueing work." });
      return;
    }
    const requestBody = {
      type: safeTrim(jobDraft.type),
      queue: safeTrim(jobDraft.queue) || "default",
      tenantId: safeTrim(jobDraft.tenantId) || "default",
      priority: clamp(Number(jobDraft.priority) || 5, 0, 9),
      maxAttempts: Math.max(Number(jobDraft.maxAttempts) || 5, 1),
      timeoutSeconds: Math.max(Number(jobDraft.timeoutSeconds) || 0, 0),
      delaySeconds: Math.max(Number(jobDraft.delaySeconds) || 0, 0),
      scheduledAt: safeTrim(jobDraft.scheduledAt) ? new Date(jobDraft.scheduledAt).toISOString() : undefined,
      schemaVersion: 1,
      workflowId: safeTrim(jobDraft.workflowId) || undefined,
      dependencies: validation.dependencies.length > 0 ? validation.dependencies : undefined,
      dependencyPolicy: validation.dependencies.length > 0 ? "block" : undefined,
      idempotencyKey: safeTrim(jobDraft.idempotencyKey) || undefined,
      dedupeWindowSeconds: validation.dedupeWindowSeconds,
      payload: validation.payload,
    };

    await runBusy("submit-job", async () => {
      if (liveMode) {
        const result = await requestJson<EnqueueResult>(
          API_ROUTES.jobs,
          { method: "POST", body: JSON.stringify(requestBody) },
          undefined,
          parseEnqueueResult,
        );
        setConsoleData((current) => replaceJob(current, result.job));
        setSelectedJobId(result.job.id);
        setSelectedTab("jobs");
        enqueueToast({
          tone: result.duplicateSuppressed ? "warning" : "success",
          title: result.duplicateSuppressed ? "Submission deduplicated" : "Job enqueued",
          description: result.duplicateSuppressed ? `Suppressed duplicate submission for ${result.job.idempotencyKey || result.job.id}.` : `${result.job.type} entered ${result.job.queue}.`,
        });
        void refreshConsole({ quiet: true, force: true });
        return;
      }

      setConsoleData((current) => {
        const duplicate = safeTrim(jobDraft.idempotencyKey)
          ? current.jobs.find((job) => job.tenantId === requestBody.tenantId && job.type === requestBody.type && safeTrim(job.idempotencyKey) === safeTrim(jobDraft.idempotencyKey))
          : undefined;
        if (duplicate) {
          setSelectedJobId(duplicate.id);
          enqueueToast({ tone: "warning", title: "Local duplicate suppressed", description: "The job matched an existing idempotency key in the current console session." });
          return current;
        }
        const nextJob = createJobFromDraft(jobDraft, validation.payload);
        const nextData = appendEvent(replaceJob(current, nextJob), makeSystemEvent("job.enqueued", { jobId: nextJob.id, queue: nextJob.queue, state: nextJob.state, message: `job queued into ${nextJob.queue}` }));
        setSelectedJobId(nextJob.id);
        setSelectedTab("jobs");
        enqueueToast({ tone: "success", title: "Job enqueued in demo mode", description: `${nextJob.type} is now visible in the console state model.` });
        return nextData;
      });
    });
  }

  async function retryJob(jobId: string) {
    await runBusy(`job-retry-${jobId}`, async () => {
      if (liveMode) {
        const job = await requestJson<Job>(API_ROUTES.jobRetry(jobId), { method: "POST" }, undefined, parseJob);
        setConsoleData((current) => removeDeadLetters(replaceJob(current, job), [jobId]));
        void refreshConsole({ quiet: true, force: true });
      } else {
        setConsoleData((current) => {
          const job = current.jobs.find((item) => item.id === jobId);
          if (!job) return current;
          const now = new Date().toISOString();
          return appendEvent(
            removeDeadLetters(replaceJob(current, { ...job, state: "queued", attempts: 0, lastError: "", result: undefined, updatedAt: now, runAt: now, startedAt: undefined, finishedAt: undefined, lastHeartbeatAt: undefined, leaseExpiresAt: undefined, throttleUntil: undefined, blockedReason: "", cancelRequested: false }), [jobId]),
            makeSystemEvent("job.retried", { jobId, queue: job.queue, state: "queued", message: "job manually retried" }),
          );
        });
      }
      enqueueToast({ tone: "success", title: "Retry queued", description: "The job was moved back to the runnable queue." });
    });
  }

  async function cancelJob(jobId: string) {
    await runBusy(`job-cancel-${jobId}`, async () => {
      if (liveMode) {
        const job = await requestJson<Job>(API_ROUTES.jobCancel(jobId), { method: "POST" }, undefined, parseJob);
        setConsoleData((current) => replaceJob(current, job));
        void refreshConsole({ quiet: true, force: true });
      } else {
        setConsoleData((current) => {
          const job = current.jobs.find((item) => item.id === jobId);
          if (!job) return current;
          const now = new Date().toISOString();
          return appendEvent(replaceJob(current, { ...job, state: "canceled", updatedAt: now, finishedAt: now, cancelRequested: true, lastError: "canceled by operator" }), makeSystemEvent("job.canceled", { jobId, queue: job.queue, state: "canceled", message: "job cancellation requested" }));
        });
      }
      enqueueToast({ tone: "info", title: "Cancellation requested", description: "Queued and scheduled work was marked for cancellation." });
    });
  }

  function adjustPriority(jobId: string, delta: number) {
    if (liveMode) {
      notifyUnsupportedLiveControl("Priority changes stay read-only in live mode", priorityControlDetail);
      return;
    }

    setConsoleData((current) => {
      const job = current.jobs.find((item) => item.id === jobId);
      if (!job) return current;
      const nextPriority = clamp(job.priority + delta, 0, 9);
      const updated = replaceJob(current, { ...job, priority: nextPriority, updatedAt: new Date().toISOString() });
      return appendEvent(updated, makeSystemEvent("job.priority_changed", { jobId, queue: job.queue, message: `priority adjusted to ${nextPriority}` }));
    });
    enqueueToast({ tone: "info", title: "Priority updated", description: "This priority change is enforced inside the console state model." });
  }

  async function replayJob(jobId: string, queue: string, payloadText: string, edited: boolean) {
    const parsedPayload = safeJsonParse(payloadText);
    if (parsedPayload.error || !parsedPayload.value) {
      enqueueToast({ tone: "warning", title: "Replay payload is invalid", description: parsedPayload.error || "Provide valid JSON before replaying this job." });
      return;
    }

    await runBusy(`job-replay-${jobId}`, async () => {
      const job = consoleData.jobs.find((item) => item.id === jobId);
      const deadLetter = findDeadLetter(consoleData, jobId);
      if (!job) return;

      if (liveMode) {
        if (deadLetter) {
          await requestJson<Job[]>(
            API_ROUTES.deadLettersReplay,
            { method: "POST", body: JSON.stringify({ jobIds: [jobId], queue, payload: parsedPayload.value }) },
            undefined,
            parseJobs,
          );
        } else {
          await requestJson<EnqueueResult>(
            API_ROUTES.jobs,
            { method: "POST", body: JSON.stringify({ type: job.type, queue, tenantId: job.tenantId, priority: job.priority, maxAttempts: job.maxAttempts, timeoutSeconds: job.timeoutSeconds, schemaVersion: job.schemaVersion, workflowId: job.workflowId || undefined, parentJobId: job.parentJobId || undefined, payload: parsedPayload.value }) },
            undefined,
            parseEnqueueResult,
          );
        }
        void refreshConsole({ quiet: true, force: true });
      } else {
        setConsoleData((current) => {
          const currentJob = current.jobs.find((item) => item.id === jobId);
          if (!currentJob) return current;
          if (deadLetter) {
            const now = new Date().toISOString();
            return appendEvent(removeDeadLetters(replaceJob(current, { ...currentJob, queue, payload: parsedPayload.value, state: "queued", attempts: 0, lastError: "", finishedAt: undefined, startedAt: undefined, leaseExpiresAt: undefined, updatedAt: now, runAt: now }), [jobId]), makeSystemEvent("job.replayed", { jobId, queue, state: "queued", message: edited ? "dead-letter replayed with edited payload" : "dead-letter replayed with original payload" }));
          }
          const replayedJob = { ...currentJob, id: createToastId(), queue, payload: parsedPayload.value, state: "queued" as const, attempts: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), runAt: new Date().toISOString(), startedAt: undefined, finishedAt: undefined, workerId: "", leaseExpiresAt: undefined, lastHeartbeatAt: undefined, lastError: "", executionMs: 0 };
          setSelectedJobId(replayedJob.id);
          return appendEvent(replaceJob(current, replayedJob), makeSystemEvent("job.replayed", { jobId: replayedJob.id, queue, state: "queued", message: edited ? "failed job cloned with edited payload" : "failed job cloned with original payload" }));
        });
      }
      enqueueToast({ tone: "success", title: edited ? "Replay issued with edited payload" : "Replay issued", description: `${job.type} will re-enter ${queue}.` });
    });
  }

  async function replaySelectedDeadLetters() {
    if (selectedDeadLetters.length === 0) {
      enqueueToast({ tone: "warning", title: "Select dead-letter jobs first", description: "Bulk replay requires at least one selected dead-letter record." });
      return;
    }
    const payload = safeTrim(bulkReplayPayload) ? safeJsonParse(bulkReplayPayload) : { value: null, error: "" };
    if (payload.error) {
      enqueueToast({ tone: "warning", title: "Replay override is invalid", description: payload.error });
      return;
    }

    await runBusy("bulk-replay", async () => {
      if (liveMode) {
        await requestJson<Job[]>(
          API_ROUTES.deadLettersReplay,
          { method: "POST", body: JSON.stringify({ jobIds: selectedDeadLetters, queue: bulkReplayQueue, payload: payload.value ?? undefined }) },
          undefined,
          parseJobs,
        );
        void refreshConsole({ quiet: true, force: true });
      } else {
        setConsoleData((current) => {
          let next = current;
          for (const jobId of selectedDeadLetters) {
            const job = next.jobs.find((item) => item.id === jobId);
            if (!job) continue;
            const now = new Date().toISOString();
            next = removeDeadLetters(replaceJob(next, { ...job, queue: bulkReplayQueue, payload: payload.value ?? job.payload, state: "queued", attempts: 0, lastError: "", updatedAt: now, runAt: now, startedAt: undefined, finishedAt: undefined }), [jobId]);
          }
          return appendEvent(next, makeSystemEvent("job.replayed", { message: `${selectedDeadLetters.length} dead-letter jobs replayed`, queue: bulkReplayQueue }));
        });
      }
      setSelectedDeadLetters([]);
      setBulkReplayPayload("");
      enqueueToast({ tone: "success", title: "Bulk replay issued", description: `${selectedDeadLetters.length} dead-letter jobs were replayed.` });
    });
  }

  async function deleteSelectedDeadLetters() {
    if (selectedDeadLetters.length === 0) {
      enqueueToast({ tone: "warning", title: "Select dead-letter jobs first", description: "Bulk delete requires at least one selected record." });
      return;
    }
    await runBusy("bulk-delete", async () => {
      if (liveMode) {
        await requestJson(API_ROUTES.deadLettersDelete, { method: "POST", body: JSON.stringify({ jobIds: selectedDeadLetters }) });
        void refreshConsole({ quiet: true, force: true });
      } else {
        setConsoleData((current) => appendEvent(removeDeadLetters(current, selectedDeadLetters), makeSystemEvent("job.dead_letter_deleted", { message: `${selectedDeadLetters.length} dead-letter jobs deleted` })));
      }
      setSelectedDeadLetters([]);
      enqueueToast({ tone: "info", title: "Dead-letter records deleted", description: "The selected DLQ metadata was removed from the console." });
    });
  }

  function setQueueControl(queueName: string, action: "pause" | "resume" | "drain") {
    if (liveMode) {
      notifyUnsupportedLiveControl("Queue controls stay read-only in live mode", queueControlDetail);
      return;
    }

    setConsoleData((current) => {
      const now = new Date().toISOString();
      const nextJobs =
        action === "drain"
          ? current.jobs.map((job) =>
              job.queue === queueName && ["queued", "scheduled", "retrying"].includes(job.state)
                ? { ...job, state: "canceled" as const, lastError: "queue drained by operator", finishedAt: now, updatedAt: now }
                : job,
            )
          : current.jobs;
      return appendEvent(
        reconcileConsoleData({
          ...current,
          jobs: nextJobs,
          queueControls: {
            ...current.queueControls,
            [queueName]: { paused: action === "pause" ? true : action === "resume" ? false : current.queueControls[queueName]?.paused ?? false, draining: action === "drain", scope: "local", updatedAt: now },
          },
        }),
        makeSystemEvent(`queue.${action}`, { queue: queueName, message: `${queueName} ${action}d` }),
      );
    });
    enqueueToast({ tone: action === "resume" ? "success" : "info", title: `${queueName} ${action}d`, description: "The queue control mutated the demo state model immediately." });
  }

  function toggleWorkerCordon(workerId: string, cordoned: boolean) {
    if (liveMode) {
      notifyUnsupportedLiveControl("Worker maintenance stays read-only in live mode", workerControlDetail);
      return;
    }

    setConsoleData((current) =>
      appendEvent({ ...current, workerControls: { ...current.workerControls, [workerId]: { cordoned, scope: "local", updatedAt: new Date().toISOString() } } }, makeSystemEvent(cordoned ? "worker.cordoned" : "worker.released", { workerId, message: cordoned ? `${workerId} cordoned for maintenance` : `${workerId} returned to service` })),
    );
    enqueueToast({ tone: cordoned ? "warning" : "success", title: cordoned ? "Worker cordoned" : "Worker returned to service", description: "The demo worker state changed immediately." });
  }

  async function submitSchedule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const validation = validateScheduleForm();
    if (Object.keys(validation.errors).length > 0 || !validation.payload) {
      setScheduleErrors(validation.errors);
      enqueueToast({ tone: "warning", title: "Schedule definition needs attention", description: "Fix the inline errors before saving the schedule." });
      return;
    }
    const scheduleBody = { name: safeTrim(scheduleDraft.name), cronExpression: safeTrim(scheduleDraft.cronExpression), queue: safeTrim(scheduleDraft.queue) || "default", type: safeTrim(scheduleDraft.type), payload: validation.payload, priority: clamp(Number(scheduleDraft.priority) || 5, 0, 9), maxAttempts: Math.max(Number(scheduleDraft.maxAttempts) || 5, 1), timeoutSeconds: Math.max(Number(scheduleDraft.timeoutSeconds) || 0, 0), enabled: scheduleDraft.enabled, timezone: safeTrim(scheduleDraft.timezone) || "UTC" };
    await runBusy("schedule-submit", async () => {
      if (liveMode) {
        await requestJson<Schedule>(API_ROUTES.schedules, { method: "POST", body: JSON.stringify(scheduleBody) }, undefined, parseSchedule);
        void refreshConsole({ quiet: true, force: true });
      } else {
        setConsoleData((current) => appendEvent(reconcileConsoleData({ ...current, schedules: [{ id: createToastId(), name: scheduleBody.name, cronExpression: scheduleBody.cronExpression, queue: scheduleBody.queue, type: scheduleBody.type, payload: scheduleBody.payload, priority: scheduleBody.priority, maxAttempts: scheduleBody.maxAttempts, timeoutSeconds: scheduleBody.timeoutSeconds, enabled: scheduleBody.enabled, timezone: scheduleBody.timezone, nextRunAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, ...current.schedules] }), makeSystemEvent("schedule.updated", { message: scheduleBody.name })));
      }
      enqueueToast({ tone: "success", title: "Schedule saved", description: `${scheduleBody.name} is now part of the schedule control plane.` });
      setScheduleDraft(defaultScheduleDraft);
    });
  }

  async function toggleSchedule(schedule: Schedule, enabled: boolean) {
    await runBusy(`schedule-${schedule.id}`, async () => {
      if (liveMode) {
        await requestJson<Schedule>(
          API_ROUTES.schedules,
          { method: "POST", body: JSON.stringify({ name: schedule.name, cronExpression: schedule.cronExpression, queue: schedule.queue, type: schedule.type, payload: schedule.payload, priority: schedule.priority, maxAttempts: schedule.maxAttempts, timeoutSeconds: schedule.timeoutSeconds, enabled, timezone: schedule.timezone }) },
          undefined,
          parseSchedule,
        );
        void refreshConsole({ quiet: true, force: true });
      } else {
        setConsoleData((current) => appendEvent(reconcileConsoleData({ ...current, schedules: current.schedules.map((item) => item.id === schedule.id ? { ...item, enabled, updatedAt: new Date().toISOString() } : item) }), makeSystemEvent("schedule.updated", { message: `${schedule.name} ${enabled ? "enabled" : "paused"}` })));
      }
      enqueueToast({ tone: enabled ? "success" : "warning", title: enabled ? "Schedule resumed" : "Schedule paused", description: schedule.name });
    });
  }

  async function triggerSchedule(schedule: Schedule) {
    await runBusy(`schedule-trigger-${schedule.id}`, async () => {
      if (liveMode) {
        await requestJson<EnqueueResult>(
          API_ROUTES.jobs,
          { method: "POST", body: JSON.stringify({ type: schedule.type, queue: schedule.queue, priority: schedule.priority, maxAttempts: schedule.maxAttempts, timeoutSeconds: schedule.timeoutSeconds, schemaVersion: 1, payload: schedule.payload, tenantId: "scheduler" }) },
          undefined,
          parseEnqueueResult,
        );
        void refreshConsole({ quiet: true, force: true });
      } else {
        const nextJob = createJobFromDraft({ ...defaultJobDraft, type: schedule.type, queue: schedule.queue, priority: String(schedule.priority), maxAttempts: String(schedule.maxAttempts), timeoutSeconds: String(schedule.timeoutSeconds), tenantId: "scheduler", payload: stringifyJson(schedule.payload) }, schedule.payload);
        setConsoleData((current) => appendEvent(replaceJob(current, nextJob), makeSystemEvent("schedule.triggered", { jobId: nextJob.id, queue: nextJob.queue, message: `${schedule.name} triggered manually` })));
        setSelectedJobId(nextJob.id);
      }
      enqueueToast({ tone: "success", title: "Schedule triggered", description: schedule.name });
    });
  }

  async function seedWorkflow() {
    await runBusy("seed-workflow", async () => {
      if (liveMode) {
        await requestJson(API_ROUTES.workflowDemoThumbnail, { method: "POST", body: JSON.stringify({ tenantId: safeTrim(jobDraft.tenantId) || "tenant-a" }) });
        void refreshConsole({ quiet: true, force: true });
      } else {
        setConsoleData((current) => addLocalWorkflowJobs(current));
      }
      enqueueToast({ tone: "success", title: "Workflow seeded", description: "A fan-out/fan-in thumbnail workflow was injected into the console." });
    });
  }

  const queueJobSummary = useMemo(() => {
    const summary = Object.fromEntries(
      QUEUES.map((queueName) => [
        queueName,
        { active: 0, queued: 0, throttled: 0, blocked: 0, completed: 0 },
      ]),
    ) as Record<string, { active: number; queued: number; throttled: number; blocked: number; completed: number }>;
    const completedByWorker: Record<string, number> = {};

    for (const job of consoleData.jobs) {
      const queue = summary[job.queue];
      if (queue) {
        if (job.state === "active") queue.active += 1;
        if (["queued", "retrying", "scheduled"].includes(job.state)) queue.queued += 1;
        if (job.state === "throttled") queue.throttled += 1;
        if (job.state === "blocked") queue.blocked += 1;
        if (job.state === "completed") queue.completed += 1;
      }

      if (job.workerId && job.state === "completed") {
        completedByWorker[job.workerId] = (completedByWorker[job.workerId] ?? 0) + 1;
      }
    }

    return { byQueue: summary, completedByWorker };
  }, [consoleData.jobs]);

  const deadLetterCountsByQueue = useMemo(
    () =>
      consoleData.snapshot.deadLetters.reduce<Record<string, number>>((result, item) => {
        result[item.queue] = (result[item.queue] ?? 0) + 1;
        return result;
      }, {}),
    [consoleData.snapshot.deadLetters],
  );

  const queuePoliciesByQueue = useMemo(
    () =>
      consoleData.snapshot.rateLimits.reduce<Record<string, typeof consoleData.snapshot.rateLimits>>((result, item) => {
        if (item.policy.scope === "queue" && item.policy.scopeValue) {
          result[item.policy.scopeValue] = [...(result[item.policy.scopeValue] ?? []), item];
        }
        return result;
      }, {}),
    [consoleData.snapshot.rateLimits],
  );

  const workerStatusesById = useMemo(
    () =>
      consoleData.workerStatuses.reduce<Record<string, (typeof consoleData.workerStatuses)[number]>>((result, item) => {
        result[item.workerId] = item;
        return result;
      }, {}),
    [consoleData.workerStatuses],
  );

  const queueViews = useMemo<QueueView[]>(
    () =>
      QUEUES.map((queueName) => {
        const summary = queueJobSummary.byQueue[queueName];
        const control = consoleData.queueControls[queueName];
        const policies = queuePoliciesByQueue[queueName] ?? [];
        const activeJobs = summary?.active ?? 0;
        const saturation = Math.min(
          100,
          policies.length > 0
            ? (policies[0].activeCount / Math.max(policies[0].policy.limit, 1)) * 100
            : activeJobs * 16,
        );

        return {
          queueName,
          control,
          activeJobs,
          queuedJobs: summary?.queued ?? 0,
          backlog: consoleData.snapshot.overview.queueLengths[queueName] ?? 0,
          throttled: summary?.throttled ?? 0,
          blocked: summary?.blocked ?? 0,
          deadLetters: deadLetterCountsByQueue[queueName] ?? 0,
          saturation,
          policies,
        };
      }),
    [consoleData.queueControls, consoleData.snapshot.overview.queueLengths, deadLetterCountsByQueue, queueJobSummary.byQueue, queuePoliciesByQueue],
  );

  const workerViews = useMemo<WorkerView[]>(
    () =>
      consoleData.snapshot.workers.map((health) => {
        const status = workerStatusesById[health.workerId];
        const control = consoleData.workerControls[health.workerId];
        return {
          ...health,
          concurrency: status?.concurrency ?? 0,
          version: status?.version ?? health.version,
          effectiveStatus: control?.cordoned ? "maintenance" : status?.status || health.status,
          throughput: queueJobSummary.completedByWorker[health.workerId] ?? 0,
          saturation: status?.concurrency
            ? Math.min((health.activeLeaseCount / status.concurrency) * 100, 100)
            : 0,
        };
      }),
    [consoleData.snapshot.workers, consoleData.workerControls, queueJobSummary.completedByWorker, workerStatusesById],
  );

  const tenantFilter = safeTrim(jobFilters.tenant).toLowerCase();
  const deadLetterSearch = safeTrim(deadLetterFilters.search).toLowerCase();
  const workerFilterQuery = safeTrim(workerFilter).toLowerCase();
  const scheduleFilterQuery = safeTrim(scheduleFilter).toLowerCase();
  const eventSearch = safeTrim(eventFilter || searchQuery).toLowerCase();

  const visibleJobs = useMemo(
    () =>
      [...consoleData.jobs]
        .filter(
          (job) =>
            (jobFilters.state === "all" || job.state === jobFilters.state) &&
            (jobFilters.queue === "all" || job.queue === jobFilters.queue) &&
            (!tenantFilter || job.tenantId.toLowerCase().includes(tenantFilter)) &&
            (!search ||
              [job.type, job.id, job.queue, job.tenantId, job.workflowId, job.idempotencyKey].some((value) =>
                safeTrim(value).toLowerCase().includes(search),
              )),
        )
        .sort((left, right) =>
          jobFilters.sort === "priority"
            ? right.priority - left.priority
            : jobFilters.sort === "created"
              ? new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
              : jobFilters.sort === "latency"
                ? right.executionMs - left.executionMs
                : new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
        ),
    [consoleData.jobs, jobFilters.queue, jobFilters.sort, jobFilters.state, search, tenantFilter],
  );

  const visibleDeadLetters = useMemo(
    () =>
      consoleData.snapshot.deadLetters.filter(
        (item) =>
          (deadLetterFilters.queue === "all" || item.queue === deadLetterFilters.queue) &&
          (deadLetterFilters.errorType === "all" || safeTrim(item.errorType) === deadLetterFilters.errorType) &&
          (!deadLetterSearch ||
            [item.job?.type, item.jobId, item.errorType, item.errorMessage, item.queue].some((value) =>
              safeTrim(value).toLowerCase().includes(deadLetterSearch),
            )),
      ),
    [consoleData.snapshot.deadLetters, deadLetterFilters.errorType, deadLetterFilters.queue, deadLetterSearch],
  );

  const visibleWorkers = useMemo(
    () =>
      workerViews.filter(
        (worker) =>
          !workerFilterQuery ||
          [worker.workerId, worker.hostname, worker.effectiveStatus, worker.queues.join(" ")].some((value) =>
            safeTrim(value).toLowerCase().includes(workerFilterQuery),
          ),
      ),
    [workerFilterQuery, workerViews],
  );

  const visibleSchedules = useMemo(
    () =>
      consoleData.schedules.filter(
        (schedule) =>
          !scheduleFilterQuery ||
          [schedule.name, schedule.type, schedule.queue, schedule.cronExpression].some((value) =>
            safeTrim(value).toLowerCase().includes(scheduleFilterQuery),
          ),
      ),
    [consoleData.schedules, scheduleFilterQuery],
  );

  const visibleEvents = useMemo(
    () =>
      consoleData.events.filter(
        (item) =>
          !eventSearch ||
          [item.kind, item.message, item.jobId, item.queue, item.workerId].some((value) =>
            safeTrim(value).toLowerCase().includes(eventSearch),
          ),
      ),
    [consoleData.events, eventSearch],
  );

  const leaderHealthy = Boolean(consoleData.snapshot.leader.schedulerId && consoleData.snapshot.leader.isLeaderHealthy);

  const jobsBusy = useMemo(
    () => ({
      submit: Boolean(busyMap["submit-job"]),
      seed: Boolean(busyMap["seed-workflow"]),
      retry: (jobId: string) => Boolean(busyMap[`job-retry-${jobId}`]),
      cancel: (jobId: string) => Boolean(busyMap[`job-cancel-${jobId}`]),
    }),
    [busyMap],
  );

  const deadLetterBusy = useMemo(
    () => ({
      replay: Boolean(busyMap["bulk-replay"]),
      delete: Boolean(busyMap["bulk-delete"]),
    }),
    [busyMap],
  );

  const handleJobFiltersChange = useCallback(
    (next: Partial<{ state: string; queue: string; sort: string; tenant: string }>) => {
      setJobFilters((current) => ({ ...current, ...next }));
    },
    [],
  );

  const handleDeadLetterFiltersChange = useCallback(
    (next: Partial<{ queue: string; errorType: string; search: string }>) => {
      setDeadLetterFilters((current) => ({ ...current, ...next }));
    },
    [],
  );

  const handleToggleDeadLetterSelection = useCallback((jobId: string) => {
    setSelectedDeadLetters((current) =>
      current.includes(jobId) ? current.filter((item) => item !== jobId) : [...current, jobId],
    );
  }, []);

  const openJobsTab = useCallback(() => {
    setSelectedTab("jobs");
  }, [setSelectedTab]);

  const refreshSnapshot = useCallback(() => {
    void refreshConsole({ force: true });
  }, [refreshConsole]);

  const reconnectNow = useCallback(() => {
    manualReconnect();
  }, [manualReconnect]);

  const seedWorkflowNow = useCallback(() => {
    void seedWorkflow();
  }, [seedWorkflow]);

  const retryJobNow = useCallback((jobId: string) => {
    void retryJob(jobId);
  }, [retryJob]);

  const cancelJobNow = useCallback((jobId: string) => {
    void cancelJob(jobId);
  }, [cancelJob]);

  const toggleScheduleNow = useCallback((schedule: Schedule, enabled: boolean) => {
    void toggleSchedule(schedule, enabled);
  }, [toggleSchedule]);

  const triggerScheduleNow = useCallback((schedule: Schedule) => {
    void triggerSchedule(schedule);
  }, [triggerSchedule]);

  const replaySelectedDeadLettersNow = useCallback(() => {
    void replaySelectedDeadLetters();
  }, [replaySelectedDeadLetters]);

  const deleteSelectedDeadLettersNow = useCallback(() => {
    void deleteSelectedDeadLetters();
  }, [deleteSelectedDeadLetters]);

  const replayJobNow = useCallback((jobId: string, queue: string, payloadText: string, edited: boolean) => {
    void replayJob(jobId, queue, payloadText, edited);
  }, [replayJob]);

  const liveStatusDetail = useMemo(() => {
    if (!liveMode) {
      return "Demo data only";
    }
    if (liveMeta.health === "offline") {
      return liveMeta.hasLiveData
        ? "The dashboard is holding the last good snapshot while the API is unreachable."
        : "The dashboard has not received a live snapshot yet.";
    }
    if (liveMeta.health === "paused") {
      return "Realtime transport is paused and polling is disabled.";
    }
    if (liveMeta.health === "reconnecting") {
      return `Realtime transport is recovering while ${liveMeta.transportLabel.toLowerCase()} protects the dashboard.`;
    }
    if (liveMeta.transportMode === "websocket") {
      return "WebSocket is the active live transport.";
    }
    if (liveMeta.transportMode === "sse") {
      return "SSE is carrying the live event stream.";
    }
    if (liveMeta.transportMode === "polling") {
      return liveUpdates
        ? "Realtime transport is degraded, so the dashboard is running in polling mode."
        : "Polling is active without realtime streaming.";
    }
    if (liveMeta.health === "degraded") {
      return "The dashboard is degraded but stable, with stale-while-revalidate enabled.";
    }
    return "Live updates are healthy.";
  }, [liveMeta.hasLiveData, liveMeta.health, liveMeta.transportLabel, liveMeta.transportMode, liveMode, liveUpdates]);

  const commandStatusItems = useMemo(
    () => [
      {
        label: "Snapshot",
        value: formatRelative(liveMeta.lastSuccessfulAt || consoleData.snapshot.overview.lastUpdatedAt),
        detail: liveMeta.dataStale ? "holding the last steady view" : "fresh",
      },
      {
        label: "Transport",
        value: liveMeta.transportLabel,
        detail: liveMeta.connectionState,
      },
      {
        label: "Leader",
        value: leaderHealthy ? "healthy" : "stale",
        detail: consoleData.snapshot.leader.schedulerId || "no leader lease",
      },
      {
        label: "Queue backlog",
        value: `${consoleData.snapshot.overview.queuedJobs + consoleData.snapshot.overview.scheduledJobs}`,
        detail: `${consoleData.snapshot.overview.activeJobs} active`,
      },
    ],
    [
      consoleData.snapshot.leader.schedulerId,
      consoleData.snapshot.overview.activeJobs,
      consoleData.snapshot.overview.lastUpdatedAt,
      consoleData.snapshot.overview.queuedJobs,
      consoleData.snapshot.overview.scheduledJobs,
      leaderHealthy,
      liveMeta.connectionState,
      liveMeta.dataStale,
      liveMeta.lastSuccessfulAt,
      liveMeta.transportLabel,
    ],
  );

  const tabContent = useMemo(() => {
    if (loading) {
      return <LoadingSkeleton />;
    }

    switch (tabKey) {
      case "overview":
        return (
          <OverviewSection
            snapshot={consoleData.snapshot}
            queueViews={queueViews}
            visibleEvents={visibleEvents}
            blockedJobs={consoleData.snapshot.blockedJobs}
            leaderHealthy={leaderHealthy}
            queueControlsEnabled={demoMode}
            queueControlHint={demoMode ? "" : queueControlDetail}
            onQueueControl={setQueueControl}
            onSelectJob={setSelectedJobId}
          />
        );
      case "jobs":
        return (
          <JobsSection
            visibleJobs={visibleJobs}
            jobDraft={jobDraft}
            jobFilters={jobFilters}
            jobFormErrors={jobFormErrors}
            busy={jobsBusy}
            priorityControlsEnabled={demoMode}
            priorityControlsHint={demoMode ? "" : priorityControlDetail}
            onSubmit={submitJob}
            onJobDraftChange={updateJobDraft}
            onJobFiltersChange={handleJobFiltersChange}
            onSeedWorkflow={seedWorkflowNow}
            onSelectJob={setSelectedJobId}
            onRetryJob={retryJobNow}
            onCancelJob={cancelJobNow}
            onAdjustPriority={adjustPriority}
          />
        );
      case "queues":
        return (
          <QueuesSection
            queueViews={queueViews}
            controlsEnabled={demoMode}
            controlsHint={demoMode ? "" : queueControlDetail}
            onQueueControl={setQueueControl}
          />
        );
      case "workers":
        return (
          <WorkersSection
            visibleWorkers={visibleWorkers}
            workerFilter={workerFilter}
            controlsEnabled={demoMode}
            controlsHint={demoMode ? "" : workerControlDetail}
            onFilterChange={setWorkerFilter}
            onCordon={toggleWorkerCordon}
            onInspectLease={setSelectedJobId}
          />
        );
      case "schedules":
        return (
          <SchedulesSection
            scheduleDraft={scheduleDraft}
            scheduleErrors={scheduleErrors}
            visibleSchedules={visibleSchedules}
            scheduleFilter={scheduleFilter}
            busy={Boolean(busyMap["schedule-submit"])}
            onSubmit={submitSchedule}
            onDraftChange={updateScheduleDraft}
            onFilterChange={setScheduleFilter}
            onToggle={toggleScheduleNow}
            onTrigger={triggerScheduleNow}
          />
        );
      case "dead-letter":
        return (
          <DeadLetterSection
            visibleDeadLetters={visibleDeadLetters}
            selectedDeadLetters={selectedDeadLetters}
            deadLetterFilters={deadLetterFilters}
            bulkReplayQueue={bulkReplayQueue}
            bulkReplayPayload={bulkReplayPayload}
            busy={deadLetterBusy}
            onFiltersChange={handleDeadLetterFiltersChange}
            onReplayQueueChange={setBulkReplayQueue}
            onReplayPayloadChange={setBulkReplayPayload}
            onReplaySelected={replaySelectedDeadLettersNow}
            onDeleteSelected={deleteSelectedDeadLettersNow}
            onToggleSelection={handleToggleDeadLetterSelection}
            onSelectJob={setSelectedJobId}
          />
        );
      case "workflows":
        return <WorkflowsSection workflowNodes={selectedInspection?.graph.nodes ?? []} />;
      case "metrics":
        return <MetricsSection snapshot={consoleData.snapshot} queueViews={queueViews} />;
      case "events":
      default:
        return <EventsSection visibleEvents={visibleEvents} eventFilter={eventFilter} onFilterChange={setEventFilter} />;
    }
  }, [
    adjustPriority,
    bulkReplayPayload,
    bulkReplayQueue,
    busyMap,
    cancelJobNow,
    consoleData.snapshot,
    deadLetterBusy,
    deadLetterFilters,
    deleteSelectedDeadLettersNow,
    demoMode,
    eventFilter,
    handleDeadLetterFiltersChange,
    handleJobFiltersChange,
    handleToggleDeadLetterSelection,
    jobDraft,
    jobFilters,
    jobFormErrors,
    jobsBusy,
    leaderHealthy,
    loading,
    priorityControlDetail,
    queueControlDetail,
    queueViews,
    replaySelectedDeadLettersNow,
    retryJobNow,
    scheduleDraft,
    scheduleErrors,
    scheduleFilter,
    seedWorkflowNow,
    selectedDeadLetters,
    selectedInspection?.graph.nodes,
    setQueueControl,
    setSelectedJobId,
    submitJob,
    submitSchedule,
    tabKey,
    toggleScheduleNow,
    toggleWorkerCordon,
    triggerScheduleNow,
    updateJobDraft,
    updateScheduleDraft,
    visibleDeadLetters,
    visibleEvents,
    visibleJobs,
    visibleSchedules,
    visibleWorkers,
    workerControlDetail,
    workerFilter,
  ]);

  return (
    <main className="app-shell">
      <div className="ambient ambient-left" aria-hidden="true" />
      <div className="ambient ambient-right" aria-hidden="true" />
      <header className="topbar surface">
        <div className="topbar-main">
          <div className="topbar-brand">
            <div className="topbar-meta">
              <span className="eyebrow">Distributed Job Platform</span>
              <div className="status-inline">
                <StatusPill pulse={liveMeta.health === "live"} value={liveMeta.health} />
                <StatusPill pulse={["websocket", "sse"].includes(liveMeta.transportMode)} value={liveMeta.transportMode} />
                <StatusPill value={leaderHealthy ? "leader healthy" : "leader stale"} />
              </div>
            </div>
            <strong>Ops Console</strong>
            <small>Calm operational visibility for queues, workers, retries, and recovery.</small>
          </div>
          <div className="topbar-actions">
            <label>
              <span>Environment</span>
              <select value={environment} onChange={(event) => setEnvironment(event.target.value)}>
                <option value="Demo Sandbox">Demo Sandbox</option>
                <option value="Staging Cluster">Staging Cluster</option>
                <option value="Prod East">Prod East</option>
              </select>
            </label>
            <label>
              <span>Polling</span>
              <select value={pollIntervalMs} onChange={(event) => setPollIntervalMs(Number(event.target.value) as PollingPreset)}>
                {POLLING_PRESETS.map((preset) => (
                  <option key={preset.value} value={preset.value}>
                    {preset.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="toggle-row">
              <input checked={liveMode} type="checkbox" onChange={(event) => setLiveMode(Boolean(event.target.checked))} />
              <span>Live mode</span>
            </label>
            <label className="toggle-row">
              <input checked={liveUpdates} type="checkbox" onChange={(event) => setLiveUpdates(Boolean(event.target.checked))} />
              <span>Live stream</span>
            </label>
          </div>
        </div>
        <div className="command-row">
          <label className="command-bar">
            <span>Search</span>
            <input
              {...autofillGuardProps}
              name="opsSearch"
              spellCheck={false}
              placeholder="Search jobs, workers, queues, workflows"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value ?? "")}
            />
            <small>Search narrows the current view and the event stream.</small>
          </label>
          <div className="command-actions">
            <button className="ghost" type="button" onClick={() => setSettingsOpen((current) => !current)}>
              {settingsOpen ? "Hide connection" : "Connection"}
            </button>
            <button type="button" onClick={refreshSnapshot}>
              Refresh snapshot
            </button>
          </div>
        </div>
        <div className="command-strip" aria-label="Command summary">
          {commandStatusItems.map((item) => (
            <article key={item.label} className="command-strip-item">
              <span>{item.label}</span>
              <strong>{item.value}</strong>
              <small>{item.detail}</small>
            </article>
          ))}
        </div>
      </header>
      <AnimatePresence>
        {settingsOpen ? (
          <motion.section className="settings-panel surface" initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -12 }} transition={FAST_TRANSITION}>
            <SectionHeader title="Connection" detail="Base URL and token settings for local, staging, or production clusters." />
            <div className="field-grid field-grid-wide">
              <label>
                <span>API base URL</span>
                <input {...autofillGuardProps} inputMode="url" name="opsConfigEndpoint" spellCheck={false} type="url" value={baseUrlInput} onChange={(event) => setBaseUrlInput(event.target.value ?? "")} />
              </label>
              <label>
                <span>Admin token</span>
                <div className="token-field">
                  <input {...credentialGuardProps} className={tokenVisible ? "" : "masked-token"} inputMode="text" name="opsConfigToken" spellCheck={false} type="text" value={token} onChange={(event) => setToken(event.target.value ?? "")} />
                  <button className="ghost" type="button" onClick={() => setTokenVisible((current) => !current)}>{tokenVisible ? "Hide" : "Show"}</button>
                </div>
              </label>
            </div>
            <div className="button-row">
              <button className="ghost" type="button" onClick={resetConnectionSettings}>
                Reset Local Defaults
              </button>
            </div>
          </motion.section>
        ) : null}
      </AnimatePresence>
      <OperationsHero
        globalError={globalError}
        leaderHealthy={leaderHealthy}
        liveMeta={liveMeta}
        liveStatusDetail={liveStatusDetail}
        queueViews={queueViews}
        snapshot={consoleData.snapshot}
        visibleEvents={visibleEvents}
        workerViews={workerViews}
        onReconnect={reconnectNow}
        onRefresh={refreshSnapshot}
      />
      <section className="tab-shell surface">
        <div className="tab-shell-copy">
          <p className="section-eyebrow">Deeper views</p>
          <strong>Operational detail</strong>
          <small>Drill into jobs, queues, workers, schedules, dead letter, workflows, metrics, and events.</small>
        </div>
        <nav className="tab-bar" aria-label="Console sections">
          {TABS.map((tab) => (
            <button key={tab.key} className={`tab-button ${tab.key === tabKey ? "active" : ""}`} type="button" onClick={() => setSelectedTab(tab.key)}>
              {tab.key === tabKey ? <motion.span className="tab-button-highlight" layoutId="active-tab-indicator" transition={LAYOUT_SPRING} /> : null}
              <span className="tab-button-label">{tab.label}</span>
            </button>
          ))}
        </nav>
      </section>
      <section className="workspace">
        <div className="content-column">
          <AnimatePresence mode="wait">
            <motion.div
              key={tabKey}
              animate={{ opacity: 1, y: 0 }}
              className="tab-panel"
              exit={{ opacity: 0, y: -8 }}
              initial={{ opacity: 0, y: 12 }}
              transition={FAST_TRANSITION}
            >
              {tabContent}
            </motion.div>
          </AnimatePresence>
        </div>
        <aside className="rail-column">
          <SideRail snapshot={consoleData.snapshot} selectedJob={selectedInspection?.job ?? null} onOpenJobs={openJobsTab} />
        </aside>
      </section>
      <JobDrawer
        inspection={selectedInspection}
        busy={Boolean(selectedInspection && busyMap[`job-replay-${selectedInspection.job.id}`])}
        updating={selectedInspectionMeta.busy}
        detailError={selectedInspectionMeta.error}
        lastUpdatedAt={selectedInspectionMeta.lastUpdatedAt}
        priorityControlsEnabled={demoMode}
        priorityControlsHint={demoMode ? "" : priorityControlDetail}
        onClose={() => setSelectedJobId("")}
        onRetry={retryJobNow}
        onCancel={cancelJobNow}
        onReplay={replayJobNow}
        onPriorityChange={adjustPriority}
      />
      <ToastViewport items={toasts} onDismiss={dismissToast} />
    </main>
  );
}
