import type {
  DashboardSnapshot,
  EnqueueResult,
  Job,
  JobInspection,
  Schedule,
  WorkerStatus,
} from "./models";

type JsonRecord = Record<string, unknown>;

export function parseDashboardSnapshot(value: unknown): DashboardSnapshot {
  const record = asRecord(value, "Dashboard snapshot");
  asRecord(record.overview, "Dashboard overview");
  asRecord(record.metrics, "Dashboard metrics");
  asRecord(record.trend, "Dashboard trend");
  return value as DashboardSnapshot;
}

export function parseJob(value: unknown): Job {
  const record = asRecord(value, "Job");
  requireString(record.id, "Job id");
  requireString(record.type, "Job type");
  requireString(record.queue, "Job queue");
  requireString(record.state, "Job state");
  return value as Job;
}

export function parseJobs(value: unknown): Job[] {
  return asArray(value, "Jobs").map((item) => parseJob(item));
}

export function parseSchedule(value: unknown): Schedule {
  const record = asRecord(value, "Schedule");
  requireString(record.id, "Schedule id");
  requireString(record.name, "Schedule name");
  requireString(record.cronExpression, "Schedule cron expression");
  return value as Schedule;
}

export function parseSchedules(value: unknown): Schedule[] {
  return asArray(value, "Schedules").map((item) => parseSchedule(item));
}

export function parseWorkerStatus(value: unknown): WorkerStatus {
  const record = asRecord(value, "Worker status");
  requireString(record.workerId, "Worker id");
  requireString(record.hostname, "Worker hostname");
  if (!Array.isArray(record.queues)) {
    throw new Error("Worker queues response was malformed.");
  }
  return value as WorkerStatus;
}

export function parseWorkerStatuses(value: unknown): WorkerStatus[] {
  return asArray(value, "Workers").map((item) => parseWorkerStatus(item));
}

export function parseJobInspection(value: unknown): JobInspection {
  const record = asRecord(value, "Job inspection");
  parseJob(record.job);
  asArray(record.attempts, "Job inspection attempts");
  asArray(record.events, "Job inspection events");
  asRecord(record.graph, "Job inspection graph");
  return value as JobInspection;
}

export function parseEnqueueResult(value: unknown): EnqueueResult {
  const record = asRecord(value, "Enqueue result");
  parseJob(record.job);
  if (typeof record.duplicateSuppressed !== "boolean") {
    throw new Error("Enqueue result duplicateSuppressed flag was malformed.");
  }
  return value as EnqueueResult;
}

export function parseUnknownArray<T>(value: unknown, label: string): T[] {
  return asArray(value, label) as T[];
}

function asRecord(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} response was malformed.`);
  }
  return value as JsonRecord;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} response was malformed.`);
  }
  return value;
}

function requireString(value: unknown, label: string) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} response was malformed.`);
  }
}
