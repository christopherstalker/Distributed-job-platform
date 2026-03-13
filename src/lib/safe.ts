import type { Job, JobDraft, JobInspection, JobState, MetricsPoint, ScheduleDraft, SystemEvent, TabKey, ToastTone } from "./models";
import { REALTIME_ROUTES } from "./api-routes";

export const QUEUES = ["critical", "default", "low"] as const;
export const JOB_TYPES = [
  "email.send",
  "report.generate",
  "cleanup.run",
  "webhook.dispatch",
  "file.ingest",
  "image.thumbnail",
  "metadata.aggregate",
  "user.notify",
] as const;
export const TABS: { key: TabKey; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "jobs", label: "Jobs" },
  { key: "queues", label: "Queues" },
  { key: "workers", label: "Workers" },
  { key: "schedules", label: "Schedules" },
  { key: "dead-letter", label: "Dead Letter" },
  { key: "workflows", label: "Workflows" },
  { key: "metrics", label: "Metrics" },
  { key: "events", label: "Events" },
];
export const STORAGE_KEYS = {
  baseUrl: "jobsystem.baseUrl",
  token: "jobsystem.token",
  liveMode: "jobsystem.liveMode",
  liveUpdates: "jobsystem.liveUpdates",
  pollIntervalMs: "jobsystem.pollIntervalMs",
  environment: "jobsystem.environment",
} as const;

export const autofillGuardProps = {
  autoComplete: "off",
  "data-bwignore": "true",
  "data-lpignore": "true",
  "data-1p-ignore": "true",
} as const;

export const credentialGuardProps = {
  autoComplete: "off",
  "data-bwignore": "true",
  "data-lpignore": "true",
  "data-1p-ignore": "true",
  "data-form-type": "other",
} as const;

export function asString(value: unknown, fallback = ""): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return fallback;
  }
  return String(value);
}

export function safeTrim(value: unknown, fallback = ""): string {
  return asString(value, fallback).trim();
}

export function safeIncludes(value: unknown, expected: string) {
  return safeTrim(value).includes(expected);
}

export function safeStartsWith(value: unknown, prefix: string) {
  return safeTrim(value).startsWith(prefix);
}

export function asNumber(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function readStoredValue(key: string, fallback = "") {
  if (typeof window === "undefined") {
    return fallback;
  }
  try {
    const stored = window.localStorage.getItem(key);
    return safeTrim(stored) || fallback;
  } catch {
    return fallback;
  }
}

export function writeStoredValue(key: string, value: unknown) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const next = asString(value);
    if (next) {
      window.localStorage.setItem(key, next);
      return;
    }
    window.localStorage.removeItem(key);
  } catch {
    // Ignore storage failures in privacy-restricted environments.
  }
}

export function clearStoredValue(key: string) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Ignore storage failures in privacy-restricted environments.
  }
}

export function normalizeBaseUrl(value: unknown) {
  const raw = safeTrim(value);
  if (!raw) {
    return null;
  }
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "ws:") {
      parsed.protocol = "http:";
    }
    if (parsed.protocol === "wss:") {
      parsed.protocol = "https:";
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return null;
    }
    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = normalizeUrlPathname(parsed.pathname);
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function buildApiUrl(baseUrl: string | null, path: string) {
  if (!baseUrl) {
    return null;
  }
  try {
    const parsed = new URL(baseUrl);
    const nextPath = splitUrlPath(path);
    parsed.pathname = joinUrlPath(parsed.pathname, nextPath.pathname);
    parsed.search = nextPath.search;
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

export function buildStreamUrl(
  baseUrl: string | null,
  path: string,
  options: {
    token?: string;
    protocol?: "http" | "ws";
  } = {},
) {
  if (!baseUrl) {
    return null;
  }
  try {
    const parsed = new URL(baseUrl);
    const nextPath = splitUrlPath(path);
    if (options.protocol === "ws") {
      parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
    }
    parsed.pathname = joinUrlPath(parsed.pathname, nextPath.pathname);
    parsed.search = nextPath.search;
    parsed.hash = "";
    const trimmedToken = safeTrim(options.token);
    if (trimmedToken) {
      parsed.searchParams.set("token", trimmedToken);
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

export function buildSocketUrl(baseUrl: string | null, token: string) {
  return buildStreamUrl(baseUrl, REALTIME_ROUTES.websocket, { protocol: "ws", token });
}

export function safeJsonParse<T>(input: unknown) {
  const raw = safeTrim(input);
  if (!raw) {
    return { value: null as T | null, error: "" };
  }
  try {
    return { value: JSON.parse(raw) as T, error: "" };
  } catch (error) {
    return {
      value: null as T | null,
      error: error instanceof Error ? error.message : "Invalid JSON",
    };
  }
}

export function stringifyJson(value: unknown) {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return "{}";
  }
}

export function formatDateTime(value?: string) {
  const raw = safeTrim(value);
  if (!raw) {
    return "n/a";
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? "n/a" : date.toLocaleString();
}

export function formatTime(value?: string) {
  const raw = safeTrim(value);
  if (!raw) {
    return "n/a";
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? "n/a" : date.toLocaleTimeString();
}

export function formatRelative(value?: string) {
  const raw = safeTrim(value);
  if (!raw) {
    return "n/a";
  }
  const date = new Date(raw);
  const timestamp = date.getTime();
  if (Number.isNaN(timestamp)) {
    return "n/a";
  }
  const deltaSeconds = Math.round((timestamp - Date.now()) / 1000);
  if (Math.abs(deltaSeconds) < 1) {
    return "now";
  }
  if (deltaSeconds > 0) {
    return `in ${deltaSeconds}s`;
  }
  return `${Math.abs(deltaSeconds)}s ago`;
}

export function formatPercent(value: number) {
  return `${value.toFixed(value >= 10 ? 1 : 2)}%`;
}

export function formatLatency(value: number) {
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}s`;
  }
  return `${Math.round(value)}ms`;
}

export function formatRate(value: number, unit = "/s") {
  return `${value.toFixed(value >= 10 ? 1 : 2)}${unit}`;
}

export function formatCompact(value: number) {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export function payloadPreview(value: unknown) {
  if (typeof value === "string") {
    return value.slice(0, 120);
  }
  if (Array.isArray(value)) {
    return `${value.length} items`;
  }
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>).slice(0, 4).join(", ");
  }
  return asString(value, "empty payload");
}

export function formatRequestError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  return "Request failed";
}

export function looksLikeAutofillError(error: unknown) {
  const message =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? `${error.name} ${error.message}`
        : asString((error as { message?: unknown })?.message);
  const normalized = safeTrim(message).toLowerCase();
  const knownExtensionMarkers = [
    "bootstrap-autofill",
    "chrome-extension://",
    "moz-extension://",
    "safari-web-extension://",
    "bitwarden",
    "lastpass",
    "1password",
    "proxyrelay",
    "receiving end does not exist",
    "could not establish connection",
    "message port closed",
    "runtime.lasterror",
    "autofill",
    "password manager",
  ];
  return (
    knownExtensionMarkers.some((marker) => normalized.includes(marker)) ||
    (normalized.includes("password") && normalized.includes("extension"))
  );
}

export function friendlyInlineError(field: keyof JobDraft | keyof ScheduleDraft, error: string) {
  if (field === "payload") {
    return `Payload JSON is invalid: ${error}`;
  }
  if (field === "cronExpression") {
    return "Cron expressions require five space-separated fields.";
  }
  if (field === "scheduledAt") {
    return "Provide a valid future timestamp.";
  }
  return error;
}

export function createToastId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.round(Math.random() * 100000)}`;
}

export function makeSystemEvent(kind: string, payload: Partial<SystemEvent> = {}): SystemEvent {
  return {
    kind,
    timestamp: new Date().toISOString(),
    ...payload,
  };
}

export function createJobFromDraft(draft: JobDraft, payload: unknown): Job {
  const now = new Date();
  const scheduledAt = safeTrim(draft.scheduledAt);
  const delaySeconds = asNumber(draft.delaySeconds, 0);
  let runAt = now;
  if (scheduledAt) {
    const parsed = new Date(scheduledAt);
    if (!Number.isNaN(parsed.getTime())) {
      runAt = parsed;
    }
  }
  if (delaySeconds > 0) {
    runAt = new Date(now.getTime() + delaySeconds * 1000);
  }
  const dependencies = parseDependencyIds(draft.dependencies);
  const state: JobState = dependencies.length > 0 ? "blocked" : runAt.getTime() > now.getTime() ? "scheduled" : "queued";

  return {
    id: createToastId(),
    type: safeTrim(draft.type) || "email.send",
    queue: safeTrim(draft.queue) || "default",
    tenantId: safeTrim(draft.tenantId) || "default",
    payload,
    priority: clamp(asNumber(draft.priority, 5), 0, 9),
    attempts: 0,
    maxAttempts: Math.max(asNumber(draft.maxAttempts, 5), 1),
    state,
    schemaVersion: 1,
    idempotencyKey: safeTrim(draft.idempotencyKey),
    workflowId: safeTrim(draft.workflowId),
    dependencyPolicy: dependencies.length > 0 ? "block" : "",
    blockedReason: dependencies.length > 0 ? `waiting on ${dependencies.length} dependencies` : "",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    runAt: runAt.toISOString(),
    timeoutSeconds: Math.max(asNumber(draft.timeoutSeconds, 60), 0),
    cancelRequested: false,
    executionMs: 0,
  };
}

export function createInspectionFallback(job: Job, jobs: Job[]): JobInspection {
  const events = buildSyntheticTimeline(job);
  const graphNodes = jobs
    .filter((candidate) => candidate.workflowId && candidate.workflowId === job.workflowId)
    .map((candidate) => ({
      jobId: candidate.id,
      type: candidate.type,
      state: candidate.state,
      queue: candidate.queue,
      parentJobId: candidate.parentJobId,
      workflowId: candidate.workflowId,
      blockedReason: candidate.blockedReason,
      dependsOn: [],
      dependents: [],
    }));
  return {
    job,
    attempts: [],
    events,
    graph: {
      rootJobId: job.id,
      nodes: graphNodes.length > 0 ? graphNodes : [{ jobId: job.id, type: job.type, state: job.state, queue: job.queue }],
    },
    idempotency: job.idempotencyKey
      ? {
          scope: `${job.tenantId}:${job.type}:${job.idempotencyKey}`,
          tenantId: job.tenantId,
          jobType: job.type,
          idempotencyKey: job.idempotencyKey,
          jobId: job.id,
          status: job.state === "completed" ? "completed" : "accepted",
          firstSeenAt: job.createdAt,
          updatedAt: job.updatedAt,
          expiresAt: new Date(new Date(job.createdAt).getTime() + 15 * 60 * 1000).toISOString(),
        }
      : null,
    deadLetter: null,
  };
}

export function buildSyntheticTimeline(job: Job) {
  const events = [
    { jobId: job.id, type: "job.enqueued", message: `job accepted into ${job.queue}`, occurredAt: job.createdAt },
  ];
  if (job.startedAt) {
    events.push({
      jobId: job.id,
      type: "job.started",
      message: job.workerId ? `lease claimed by ${job.workerId}` : "worker started job",
      occurredAt: job.startedAt,
    });
  }
  if (job.finishedAt && job.state === "completed") {
    events.push({
      jobId: job.id,
      type: "job.completed",
      message: "job completed successfully",
      occurredAt: job.finishedAt,
    });
  }
  if (job.finishedAt && job.state === "failed") {
    events.push({
      jobId: job.id,
      type: "job.failed",
      message: job.lastError || "job failed",
      occurredAt: job.finishedAt,
    });
  }
  if (job.state === "blocked") {
    events.push({
      jobId: job.id,
      type: "job.blocked",
      message: job.blockedReason || "waiting on dependencies",
      occurredAt: job.updatedAt,
    });
  }
  return events.sort((left, right) => new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime());
}

export function seriesValue(series: MetricsPoint[]) {
  const latest = series[series.length - 1];
  return latest ? latest.value : 0;
}

export function statusTone(value: string | undefined): ToastTone | "neutral" {
  const normalized = safeTrim(value).toLowerCase();
  if (!normalized) {
    return "neutral";
  }
  if (["completed", "healthy", "open", "leader healthy", "enabled", "live", "websocket", "sse"].includes(normalized)) {
    return "success";
  }
  if (["failed", "canceled", "closed", "stale", "offline"].includes(normalized)) {
    return "danger";
  }
  if (["blocked", "throttled", "active", "draining", "polling", "retrying", "degraded", "reconnecting", "paused"].includes(normalized)) {
    return "warning";
  }
  if (["connecting"].includes(normalized)) {
    return "info";
  }
  return "info";
}

export function parseDependencyIds(value: unknown) {
  return safeTrim(value)
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeUrlPathname(pathname: string) {
  if (!pathname || pathname === "/") {
    return "/";
  }
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function splitUrlPath(path: string) {
  const raw = safeTrim(path);
  if (!raw) {
    return { pathname: "/", search: "" };
  }

  const hashIndex = raw.indexOf("#");
  const pathWithoutHash = hashIndex >= 0 ? raw.slice(0, hashIndex) : raw;
  const searchIndex = pathWithoutHash.indexOf("?");

  if (searchIndex < 0) {
    return { pathname: pathWithoutHash, search: "" };
  }

  return {
    pathname: pathWithoutHash.slice(0, searchIndex) || "/",
    search: pathWithoutHash.slice(searchIndex),
  };
}

function joinUrlPath(basePath: string, nextPath: string) {
  const baseSegments = normalizeUrlPathname(basePath)
    .replace(/^\/+/, "")
    .split("/")
    .filter(Boolean);
  const nextSegments = safeTrim(nextPath)
    .replace(/^\/+/, "")
    .split("/")
    .filter(Boolean);

  if (nextSegments.length === 0) {
    return baseSegments.length === 0 ? "/" : `/${baseSegments.join("/")}`;
  }

  while (baseSegments.length > 0 && nextSegments.length > 0 && baseSegments[baseSegments.length - 1] === nextSegments[0]) {
    nextSegments.shift();
  }

  const merged = [...baseSegments, ...nextSegments];
  return merged.length === 0 ? "/" : `/${merged.join("/")}`;
}
