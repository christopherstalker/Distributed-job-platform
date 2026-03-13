export type JobState =
  | "queued"
  | "scheduled"
  | "retrying"
  | "blocked"
  | "throttled"
  | "active"
  | "completed"
  | "failed"
  | "canceled";

export type ConnectionState = "connecting" | "open" | "closed" | "polling" | "demo";

export type LiveHealth = "live" | "degraded" | "reconnecting" | "offline" | "paused" | "demo";

export type TransportMode = "websocket" | "sse" | "polling" | "degraded" | "offline" | "demo";

export type TransportConnectionState =
  | "idle"
  | "connecting"
  | "live"
  | "polling"
  | "degraded"
  | "offline"
  | "paused"
  | "demo";

export type TransportStatus = {
  mode: TransportMode;
  state: TransportConnectionState;
  attempt: number;
  lastMessageAt: string;
  lastFailureAt: string;
  lastError: string;
  degradedReason: string;
  nextRetryAt: string;
};

export type PollingPreset = 0 | 5000 | 15000 | 30000;

export type MetricsPoint = {
  timestamp: string;
  value: number;
};

export type LatencySummary = {
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
};

export type Job = {
  id: string;
  type: string;
  queue: string;
  tenantId: string;
  payload: unknown;
  priority: number;
  attempts: number;
  maxAttempts: number;
  state: JobState;
  schemaVersion: number;
  idempotencyKey?: string;
  workflowId?: string;
  parentJobId?: string;
  dependencyPolicy?: string;
  blockedReason?: string;
  createdAt: string;
  updatedAt: string;
  runAt: string;
  startedAt?: string;
  finishedAt?: string;
  lastHeartbeatAt?: string;
  leaseExpiresAt?: string;
  throttleUntil?: string;
  lastError?: string;
  result?: unknown;
  workerId?: string;
  leaseToken?: string;
  timeoutSeconds: number;
  cancelRequested: boolean;
  executionMs: number;
};

export type JobAttempt = {
  id: number;
  jobId: string;
  attempt: number;
  workerId: string;
  leaseToken?: string;
  status: string;
  errorType?: string;
  errorMessage?: string;
  stackTrace?: string;
  leaseExpired: boolean;
  startedAt: string;
  finishedAt?: string;
};

export type JobEvent = {
  jobId: string;
  type: string;
  message: string;
  metadata?: unknown;
  occurredAt: string;
};

export type DependencyNode = {
  jobId: string;
  type: string;
  state: JobState;
  queue: string;
  parentJobId?: string;
  workflowId?: string;
  blockedReason?: string;
  dependencyPolicy?: string;
  dependsOn?: string[];
  dependents?: string[];
};

export type DependencyGraph = {
  rootJobId: string;
  nodes: DependencyNode[];
};

export type IdempotencyRecord = {
  scope: string;
  tenantId: string;
  jobType: string;
  idempotencyKey: string;
  jobId: string;
  status: string;
  outcome?: unknown;
  firstSeenAt: string;
  updatedAt: string;
  expiresAt: string;
};

export type DeadLetter = {
  jobId: string;
  queue: string;
  workerId: string;
  errorType?: string;
  errorMessage: string;
  stackTrace?: string;
  failedAt: string;
  lastAttempt: number;
  replayCount: number;
  lastReplayedAt?: string;
  job?: Job;
  attempts?: JobAttempt[];
};

export type WorkerLeaseHealth = {
  workerId: string;
  hostname: string;
  status: string;
  queues: string[];
  lastSeenAt: string;
  heartbeatAgeMs: number;
  activeLeaseCount: number;
  oldestLeaseAgeMs: number;
  oldestLeaseJobId?: string;
  version: string;
  startedAt: string;
  leaseExpiresAt?: string;
};

export type WorkerStatus = {
  workerId: string;
  hostname: string;
  queues: string[];
  concurrency: number;
  status: string;
  startedAt: string;
  lastSeenAt: string;
  version: string;
};

export type RateLimitPolicy = {
  id: string;
  name: string;
  scope: string;
  scopeValue?: string;
  mode: string;
  limit: number;
  windowSeconds: number;
  burst: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type RateLimitStatus = {
  policy: RateLimitPolicy;
  activeCount: number;
  recentCount: number;
  throttled: boolean;
};

export type SchedulerLeaderStatus = {
  schedulerId?: string;
  token?: string;
  isLeaderHealthy?: boolean;
  acquiredAt?: string;
  lastHeartbeatAt?: string;
  leaseExpiresAt?: string;
};

export type Schedule = {
  id: string;
  name: string;
  cronExpression: string;
  queue: string;
  type: string;
  payload: unknown;
  priority: number;
  maxAttempts: number;
  timeoutSeconds: number;
  enabled: boolean;
  timezone: string;
  nextRunAt: string;
  lastRunAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type SystemEvent = {
  kind: string;
  jobId?: string;
  queue?: string;
  workerId?: string;
  state?: JobState;
  message?: string;
  timestamp: string;
};

export type DashboardSnapshot = {
  overview: {
    totalJobs: number;
    queuedJobs: number;
    blockedJobs: number;
    throttledJobs: number;
    activeJobs: number;
    failedJobs: number;
    retryingJobs: number;
    completedJobs: number;
    scheduledJobs: number;
    canceledJobs: number;
    queueLengths: Record<string, number>;
    averageExecMs: number;
    lastUpdatedAt: string;
    activeWorkers: number;
    delayedBacklog: number;
  };
  metrics: {
    jobsPerSecond: number;
    retryRate: number;
    deadLetterRate: number;
    executionLatency: LatencySummary;
    queueLatency: LatencySummary;
    maxWorkerHeartbeatAgeMs: number;
  };
  trend: {
    throughput: MetricsPoint[];
    executionP95Ms: MetricsPoint[];
    queueLatencyP95Ms: MetricsPoint[];
    retryRate: MetricsPoint[];
    deadLetterRate: MetricsPoint[];
  };
  workers: WorkerLeaseHealth[];
  deadLetters: DeadLetter[];
  blockedJobs: Job[];
  throttledJobs: Job[];
  rateLimits: RateLimitStatus[];
  leader: SchedulerLeaderStatus;
};

export type JobInspection = {
  job: Job;
  attempts: JobAttempt[];
  events: JobEvent[];
  graph: DependencyGraph;
  idempotency?: IdempotencyRecord | null;
  deadLetter?: DeadLetter | null;
};

export type EnqueueResult = {
  job: Job;
  duplicateSuppressed: boolean;
  idempotency?: IdempotencyRecord | null;
};

export type QueueControl = {
  paused: boolean;
  draining: boolean;
  scope: "live" | "local";
  updatedAt: string;
};

export type WorkerControl = {
  cordoned: boolean;
  scope: "live" | "local";
  updatedAt: string;
};

export type ConsoleData = {
  snapshot: DashboardSnapshot;
  jobs: Job[];
  schedules: Schedule[];
  events: SystemEvent[];
  workerStatuses: WorkerStatus[];
  inspections: Record<string, JobInspection>;
  queueControls: Record<string, QueueControl>;
  workerControls: Record<string, WorkerControl>;
  lastHydratedAt: string;
  source: "demo" | "live";
};

export type QueueView = {
  queueName: string;
  control?: QueueControl;
  activeJobs: number;
  queuedJobs: number;
  backlog: number;
  throttled: number;
  blocked: number;
  deadLetters: number;
  saturation: number;
  policies: RateLimitStatus[];
};

export type WorkerView = WorkerLeaseHealth & {
  concurrency: number;
  effectiveStatus: string;
  throughput: number;
  saturation: number;
};

export type ToastTone = "info" | "success" | "warning" | "danger";

export type Toast = {
  id: string;
  title: string;
  description?: string;
  tone: ToastTone;
};

export type TabKey =
  | "overview"
  | "jobs"
  | "queues"
  | "workers"
  | "schedules"
  | "dead-letter"
  | "workflows"
  | "metrics"
  | "events";

export type JobDraft = {
  type: string;
  queue: string;
  tenantId: string;
  priority: string;
  maxAttempts: string;
  timeoutSeconds: string;
  delaySeconds: string;
  scheduledAt: string;
  workflowId: string;
  dependencies: string;
  idempotencyKey: string;
  dedupeWindowSeconds: string;
  payload: string;
};

export type ScheduleDraft = {
  name: string;
  cronExpression: string;
  queue: string;
  type: string;
  priority: string;
  maxAttempts: string;
  timeoutSeconds: string;
  timezone: string;
  enabled: boolean;
  payload: string;
};
