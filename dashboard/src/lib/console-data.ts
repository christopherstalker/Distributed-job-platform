import type {
  ConsoleData,
  DashboardSnapshot,
  DeadLetter,
  DependencyGraph,
  Job,
  JobAttempt,
  JobInspection,
  JobState,
  QueueControl,
  RateLimitStatus,
  Schedule,
  SystemEvent,
  WorkerLeaseHealth,
  WorkerStatus,
} from "./models";
import { createEventFingerprint, stableSerialize } from "./live-refresh";
import { QUEUES, createInspectionFallback, createToastId, makeSystemEvent } from "./safe";

type HydrationInput = {
  snapshot: DashboardSnapshot;
  jobs: Job[];
  schedules: Schedule[];
  workerStatuses: WorkerStatus[];
  events?: SystemEvent[];
};

export function createEmptySnapshot(): DashboardSnapshot {
  return {
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
      lastUpdatedAt: "",
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
}

export function createEmptyConsoleData(source: ConsoleData["source"] = "demo"): ConsoleData {
  return {
    snapshot: createEmptySnapshot(),
    jobs: [],
    schedules: [],
    events: [],
    workerStatuses: [],
    inspections: {},
    queueControls: {},
    workerControls: {},
    lastHydratedAt: "",
    source,
  };
}

export function createConsoleDataFromApi(input: HydrationInput): ConsoleData {
  const seed: ConsoleData = {
    snapshot: input.snapshot,
    jobs: input.jobs,
    schedules: input.schedules,
    events: input.events ?? [],
    workerStatuses: input.workerStatuses,
    inspections: {},
    queueControls: {},
    workerControls: {},
    lastHydratedAt: new Date().toISOString(),
    source: "live",
  };
  return reconcileConsoleData(seed);
}

export function stabilizeConsoleData(previous: ConsoleData, next: ConsoleData): ConsoleData {
  const jobs = reuseList(previous.jobs, next.jobs, (job) => job.id);
  const schedules = reuseList(previous.schedules, next.schedules, (schedule) => schedule.id);
  const events = reuseList(previous.events, next.events, createEventFingerprint);
  const workerStatuses = reuseList(previous.workerStatuses, next.workerStatuses, (worker) => worker.workerId);
  const workers = reuseList(previous.snapshot.workers, next.snapshot.workers, (worker) => worker.workerId);
  const deadLetters = reuseList(previous.snapshot.deadLetters, next.snapshot.deadLetters, (item) => item.jobId);
  const blockedJobs = reuseList(previous.snapshot.blockedJobs, next.snapshot.blockedJobs, (job) => job.id);
  const throttledJobs = reuseList(previous.snapshot.throttledJobs, next.snapshot.throttledJobs, (job) => job.id);
  const rateLimits = reuseList(previous.snapshot.rateLimits, next.snapshot.rateLimits, (item) => item.policy.id);
  const trend = {
    throughput: reuseList(previous.snapshot.trend.throughput, next.snapshot.trend.throughput, (point) => point.timestamp),
    executionP95Ms: reuseList(previous.snapshot.trend.executionP95Ms, next.snapshot.trend.executionP95Ms, (point) => point.timestamp),
    queueLatencyP95Ms: reuseList(previous.snapshot.trend.queueLatencyP95Ms, next.snapshot.trend.queueLatencyP95Ms, (point) => point.timestamp),
    retryRate: reuseList(previous.snapshot.trend.retryRate, next.snapshot.trend.retryRate, (point) => point.timestamp),
    deadLetterRate: reuseList(previous.snapshot.trend.deadLetterRate, next.snapshot.trend.deadLetterRate, (point) => point.timestamp),
  };
  const stabilizedTrend = reuseValue(previous.snapshot.trend, trend);
  const stabilizedOverview = reuseValue(previous.snapshot.overview, {
    ...next.snapshot.overview,
    queueLengths: reuseValue(previous.snapshot.overview.queueLengths, next.snapshot.overview.queueLengths),
  });
  const stabilizedSnapshot = reuseValue(previous.snapshot, {
    ...next.snapshot,
    overview: stabilizedOverview,
    metrics: reuseValue(previous.snapshot.metrics, next.snapshot.metrics),
    trend: stabilizedTrend,
    workers,
    deadLetters,
    blockedJobs,
    throttledJobs,
    rateLimits,
    leader: reuseValue(previous.snapshot.leader, next.snapshot.leader),
  });

  return {
    ...next,
    snapshot: stabilizedSnapshot,
    jobs,
    schedules,
    events,
    workerStatuses,
  };
}

export function reconcileConsoleData(data: ConsoleData): ConsoleData {
  const sortedJobs = [...data.jobs].sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
  const sortedSchedules = [...data.schedules].sort((left, right) => new Date(left.nextRunAt).getTime() - new Date(right.nextRunAt).getTime());
  const sortedEvents = sortEvents(data.events);
  const summary = summarizeJobs(sortedJobs, data.snapshot.workers, data.snapshot.rateLimits);
  const lastUpdatedAt = data.snapshot.overview.lastUpdatedAt || data.lastHydratedAt || new Date().toISOString();

  return {
    ...data,
    jobs: sortedJobs,
    schedules: sortedSchedules,
    events: sortedEvents,
    snapshot: {
      ...data.snapshot,
      overview: {
        ...data.snapshot.overview,
        ...summary,
        lastUpdatedAt,
      },
      blockedJobs: sortedJobs.filter((job) => job.state === "blocked").slice(0, 16),
      throttledJobs: sortedJobs.filter((job) => job.state === "throttled").slice(0, 16),
      deadLetters: [...data.snapshot.deadLetters].sort((left, right) => new Date(right.failedAt).getTime() - new Date(left.failedAt).getTime()),
      workers: [...data.snapshot.workers].sort((left, right) => left.heartbeatAgeMs - right.heartbeatAgeMs),
    },
  };
}

export function upsertInspection(data: ConsoleData, inspection: JobInspection) {
  return {
    ...data,
    inspections: {
      ...data.inspections,
      [inspection.job.id]: inspection,
    },
  };
}

export function getInspection(data: ConsoleData, jobId: string) {
  const existing = data.inspections[jobId];
  if (existing) {
    return existing;
  }
  const job = data.jobs.find((candidate) => candidate.id === jobId);
  return job ? createInspectionFallback(job, data.jobs) : null;
}

export function mergeQueueControls(current: Record<string, QueueControl>, next: Record<string, QueueControl>) {
  return { ...current, ...next };
}

export function createDemoConsoleData(): ConsoleData {
  const now = Date.now();
  const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  const minutesFromNow = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
  const secondsAgo = (seconds: number) => new Date(now - seconds * 1000).toISOString();

  const workflowId = `wf-${createToastId()}`;
  const rootJobId = createToastId();
  const ingestId = createToastId();
  const thumbSmId = createToastId();
  const thumbMdId = createToastId();
  const aggregateId = createToastId();
  const deadJobId = createToastId();
  const retryJobId = createToastId();
  const throttledJobId = createToastId();
  const scheduledJobId = createToastId();
  const activeJobId = createToastId();
  const idempotentJobId = createToastId();

  const jobs: Job[] = [
    {
      id: ingestId,
      type: "file.ingest",
      queue: "default",
      tenantId: "tenant-a",
      payload: { fileId: workflowId, source: "s3://incoming/asset.png", durationMs: 250 },
      priority: 6,
      attempts: 1,
      maxAttempts: 5,
      state: "completed",
      schemaVersion: 1,
      workflowId,
      createdAt: minutesAgo(38),
      updatedAt: minutesAgo(35),
      runAt: minutesAgo(38),
      startedAt: minutesAgo(37),
      finishedAt: minutesAgo(35),
      timeoutSeconds: 45,
      cancelRequested: false,
      executionMs: 1810,
    },
    {
      id: thumbSmId,
      type: "image.thumbnail",
      queue: "default",
      tenantId: "tenant-a",
      payload: { fileId: workflowId, size: "sm", durationMs: 210 },
      priority: 5,
      attempts: 1,
      maxAttempts: 5,
      state: "active",
      schemaVersion: 1,
      workflowId,
      parentJobId: rootJobId,
      workerId: "worker-a",
      leaseToken: "lease-thumb-sm",
      createdAt: minutesAgo(35),
      updatedAt: secondsAgo(8),
      runAt: minutesAgo(35),
      startedAt: minutesAgo(1),
      lastHeartbeatAt: secondsAgo(4),
      leaseExpiresAt: secondsAgo(-22),
      timeoutSeconds: 60,
      cancelRequested: false,
      executionMs: 0,
    },
    {
      id: thumbMdId,
      type: "image.thumbnail",
      queue: "default",
      tenantId: "tenant-a",
      payload: { fileId: workflowId, size: "md", durationMs: 250 },
      priority: 5,
      attempts: 0,
      maxAttempts: 5,
      state: "blocked",
      schemaVersion: 1,
      workflowId,
      parentJobId: rootJobId,
      dependencyPolicy: "block",
      blockedReason: "waiting on metadata.aggregate to fan-in",
      createdAt: minutesAgo(35),
      updatedAt: minutesAgo(2),
      runAt: minutesAgo(35),
      timeoutSeconds: 60,
      cancelRequested: false,
      executionMs: 0,
    },
    {
      id: aggregateId,
      type: "metadata.aggregate",
      queue: "critical",
      tenantId: "tenant-a",
      payload: { fileId: workflowId, durationMs: 320 },
      priority: 8,
      attempts: 2,
      maxAttempts: 5,
      state: "retrying",
      schemaVersion: 1,
      workflowId,
      parentJobId: rootJobId,
      lastError: "downstream metadata store timed out",
      createdAt: minutesAgo(29),
      updatedAt: minutesAgo(1),
      runAt: minutesFromNow(3),
      timeoutSeconds: 90,
      cancelRequested: false,
      executionMs: 4200,
    },
    {
      id: deadJobId,
      type: "webhook.dispatch",
      queue: "critical",
      tenantId: "tenant-b",
      payload: { destination: "https://api.vendor.dev/hooks", durationMs: 900 },
      priority: 9,
      attempts: 5,
      maxAttempts: 5,
      state: "failed",
      schemaVersion: 1,
      createdAt: minutesAgo(72),
      updatedAt: minutesAgo(12),
      runAt: minutesAgo(72),
      startedAt: minutesAgo(15),
      finishedAt: minutesAgo(12),
      workerId: "worker-b",
      lastError: "remote 500 after 3 lease recoveries",
      timeoutSeconds: 45,
      cancelRequested: false,
      executionMs: 7920,
    },
    {
      id: retryJobId,
      type: "report.generate",
      queue: "default",
      tenantId: "tenant-a",
      payload: { reportId: "rpt-883", range: "30d" },
      priority: 3,
      attempts: 2,
      maxAttempts: 5,
      state: "queued",
      schemaVersion: 1,
      createdAt: minutesAgo(8),
      updatedAt: minutesAgo(1),
      runAt: minutesAgo(1),
      timeoutSeconds: 180,
      cancelRequested: false,
      executionMs: 0,
    },
    {
      id: throttledJobId,
      type: "email.send",
      queue: "critical",
      tenantId: "tenant-a",
      payload: { recipient: "ops@tenant-a.dev", campaign: "digest" },
      priority: 7,
      attempts: 1,
      maxAttempts: 5,
      state: "throttled",
      schemaVersion: 1,
      idempotencyKey: "daily-digest:tenant-a",
      throttleUntil: minutesFromNow(6),
      lastError: "rate-limited by tenant-a-rate",
      createdAt: minutesAgo(3),
      updatedAt: minutesAgo(1),
      runAt: minutesAgo(3),
      timeoutSeconds: 30,
      cancelRequested: false,
      executionMs: 0,
    },
    {
      id: scheduledJobId,
      type: "cleanup.run",
      queue: "low",
      tenantId: "tenant-platform",
      payload: { resource: "blob-cache", dryRun: false },
      priority: 1,
      attempts: 0,
      maxAttempts: 3,
      state: "scheduled",
      schemaVersion: 1,
      createdAt: minutesAgo(6),
      updatedAt: minutesAgo(5),
      runAt: minutesFromNow(24),
      timeoutSeconds: 120,
      cancelRequested: false,
      executionMs: 0,
    },
    {
      id: activeJobId,
      type: "user.notify",
      queue: "critical",
      tenantId: "tenant-enterprise",
      payload: { userId: "user-92", channel: "sms" },
      priority: 9,
      attempts: 1,
      maxAttempts: 4,
      state: "active",
      schemaVersion: 1,
      workerId: "worker-c",
      leaseToken: "lease-notify-1",
      createdAt: minutesAgo(2),
      updatedAt: secondsAgo(3),
      runAt: minutesAgo(2),
      startedAt: secondsAgo(47),
      lastHeartbeatAt: secondsAgo(3),
      leaseExpiresAt: secondsAgo(-18),
      timeoutSeconds: 25,
      cancelRequested: false,
      executionMs: 0,
    },
    {
      id: idempotentJobId,
      type: "email.send",
      queue: "default",
      tenantId: "tenant-a",
      payload: { recipient: "finance@tenant-a.dev", template: "invoice-ready" },
      priority: 4,
      attempts: 1,
      maxAttempts: 5,
      state: "completed",
      schemaVersion: 1,
      idempotencyKey: "invoice-ready:2026-03-12:42",
      createdAt: minutesAgo(19),
      updatedAt: minutesAgo(17),
      runAt: minutesAgo(19),
      startedAt: minutesAgo(18),
      finishedAt: minutesAgo(17),
      workerId: "worker-a",
      timeoutSeconds: 30,
      cancelRequested: false,
      executionMs: 860,
    },
  ];

  const deadLetters: DeadLetter[] = [
    {
      jobId: deadJobId,
      queue: "critical",
      workerId: "worker-b",
      errorType: "remote_error",
      errorMessage: "remote 500 after 3 lease recoveries",
      stackTrace: "POST /hooks => 500\nlease recovered twice before final failure",
      failedAt: minutesAgo(12),
      lastAttempt: 5,
      replayCount: 2,
      lastReplayedAt: minutesAgo(26),
      job: jobs.find((job) => job.id === deadJobId),
      attempts: [
        {
          id: 51,
          jobId: deadJobId,
          attempt: 5,
          workerId: "worker-b",
          leaseToken: "lease-webhook-5",
          status: "failed",
          errorType: "remote_error",
          errorMessage: "remote 500",
          leaseExpired: true,
          startedAt: minutesAgo(16),
          finishedAt: minutesAgo(12),
        },
        {
          id: 48,
          jobId: deadJobId,
          attempt: 4,
          workerId: "worker-b",
          leaseToken: "lease-webhook-4",
          status: "failed",
          errorType: "timeout",
          errorMessage: "worker lost lease heartbeat",
          leaseExpired: true,
          startedAt: minutesAgo(30),
          finishedAt: minutesAgo(27),
        },
      ],
    },
  ];

  const workerLeaseHealth: WorkerLeaseHealth[] = [
    {
      workerId: "worker-a",
      hostname: "ops-eu-1",
      status: "healthy",
      queues: ["critical", "default"],
      lastSeenAt: secondsAgo(2),
      heartbeatAgeMs: 2400,
      activeLeaseCount: 1,
      oldestLeaseAgeMs: 44000,
      oldestLeaseJobId: thumbSmId,
      version: "2026.03.12",
      startedAt: minutesAgo(180),
      leaseExpiresAt: secondsAgo(-20),
    },
    {
      workerId: "worker-b",
      hostname: "ops-us-2",
      status: "healthy",
      queues: ["critical"],
      lastSeenAt: secondsAgo(5),
      heartbeatAgeMs: 5100,
      activeLeaseCount: 0,
      oldestLeaseAgeMs: 0,
      version: "2026.03.12",
      startedAt: minutesAgo(95),
    },
    {
      workerId: "worker-c",
      hostname: "ops-us-3",
      status: "healthy",
      queues: ["critical", "default", "low"],
      lastSeenAt: secondsAgo(3),
      heartbeatAgeMs: 3100,
      activeLeaseCount: 1,
      oldestLeaseAgeMs: 47000,
      oldestLeaseJobId: activeJobId,
      version: "2026.03.12",
      startedAt: minutesAgo(61),
      leaseExpiresAt: secondsAgo(-18),
    },
  ];

  const workerStatuses: WorkerStatus[] = [
    {
      workerId: "worker-a",
      hostname: "ops-eu-1",
      queues: ["critical", "default"],
      concurrency: 24,
      status: "healthy",
      startedAt: minutesAgo(180),
      lastSeenAt: secondsAgo(2),
      version: "2026.03.12",
    },
    {
      workerId: "worker-b",
      hostname: "ops-us-2",
      queues: ["critical"],
      concurrency: 12,
      status: "healthy",
      startedAt: minutesAgo(95),
      lastSeenAt: secondsAgo(5),
      version: "2026.03.12",
    },
    {
      workerId: "worker-c",
      hostname: "ops-us-3",
      queues: ["critical", "default", "low"],
      concurrency: 32,
      status: "healthy",
      startedAt: minutesAgo(61),
      lastSeenAt: secondsAgo(3),
      version: "2026.03.12",
    },
  ];

  const rateLimits: RateLimitStatus[] = [
    {
      policy: {
        id: createToastId(),
        name: "tenant-a-rate",
        scope: "tenant",
        scopeValue: "tenant-a",
        mode: "rate",
        limit: 100,
        windowSeconds: 60,
        burst: 0,
        enabled: true,
        createdAt: minutesAgo(240),
        updatedAt: minutesAgo(11),
      },
      activeCount: 0,
      recentCount: 96,
      throttled: true,
    },
    {
      policy: {
        id: createToastId(),
        name: "critical-concurrency",
        scope: "queue",
        scopeValue: "critical",
        mode: "concurrency",
        limit: 12,
        windowSeconds: 30,
        burst: 0,
        enabled: true,
        createdAt: minutesAgo(240),
        updatedAt: minutesAgo(9),
      },
      activeCount: 10,
      recentCount: 0,
      throttled: false,
    },
  ];

  const schedules: Schedule[] = [
    {
      id: createToastId(),
      name: "daily-finance-digest",
      cronExpression: "0 6 * * *",
      queue: "critical",
      type: "email.send",
      payload: { recipient: "finance@tenant-a.dev", template: "daily-digest" },
      priority: 7,
      maxAttempts: 5,
      timeoutSeconds: 30,
      enabled: true,
      timezone: "UTC",
      nextRunAt: minutesFromNow(110),
      lastRunAt: minutesAgo(1330),
      createdAt: minutesAgo(640),
      updatedAt: minutesAgo(40),
    },
    {
      id: createToastId(),
      name: "thumbnail-backfill",
      cronExpression: "*/15 * * * *",
      queue: "default",
      type: "metadata.aggregate",
      payload: { source: "backfill", durationMs: 400 },
      priority: 4,
      maxAttempts: 4,
      timeoutSeconds: 90,
      enabled: false,
      timezone: "UTC",
      nextRunAt: minutesFromNow(15),
      lastRunAt: minutesAgo(21),
      createdAt: minutesAgo(210),
      updatedAt: minutesAgo(21),
    },
  ];

  const trendSeries = Array.from({ length: 12 }, (_, index) => ({
    timestamp: minutesAgo(55 - index * 5),
    throughput: 24 + index * 1.8 + (index % 3),
    queueP95: 420 + index * 11,
    executionP95: 980 + index * 16,
    retryRate: 1.1 + index * 0.09,
    deadRate: 0.18 + (index % 4) * 0.05,
  }));

  const snapshot: DashboardSnapshot = {
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
      averageExecMs: 1285,
      lastUpdatedAt: new Date().toISOString(),
      activeWorkers: workerStatuses.length,
      delayedBacklog: 4,
    },
    metrics: {
      jobsPerSecond: 31.7,
      retryRate: 1.62,
      deadLetterRate: 0.36,
      executionLatency: { p50Ms: 420, p95Ms: 1180, p99Ms: 4210 },
      queueLatency: { p50Ms: 78, p95Ms: 560, p99Ms: 2100 },
      maxWorkerHeartbeatAgeMs: Math.max(...workerLeaseHealth.map((item) => item.heartbeatAgeMs)),
    },
    trend: {
      throughput: trendSeries.map((point) => ({ timestamp: point.timestamp, value: point.throughput })),
      queueLatencyP95Ms: trendSeries.map((point) => ({ timestamp: point.timestamp, value: point.queueP95 })),
      executionP95Ms: trendSeries.map((point) => ({ timestamp: point.timestamp, value: point.executionP95 })),
      retryRate: trendSeries.map((point) => ({ timestamp: point.timestamp, value: point.retryRate })),
      deadLetterRate: trendSeries.map((point) => ({ timestamp: point.timestamp, value: point.deadRate })),
    },
    workers: workerLeaseHealth,
    deadLetters,
    blockedJobs: [],
    throttledJobs: [],
    rateLimits,
    leader: {
      schedulerId: "scheduler-a",
      isLeaderHealthy: true,
      acquiredAt: minutesAgo(140),
      lastHeartbeatAt: secondsAgo(2),
      leaseExpiresAt: secondsAgo(-14),
    },
  };

  const events: SystemEvent[] = [
    makeSystemEvent("scheduler.failover", { message: "scheduler-b yielded leadership after lease renewal lag", timestamp: minutesAgo(16) }),
    makeSystemEvent("job.recovered_failed", {
      jobId: deadJobId,
      queue: "critical",
      state: "failed",
      message: "orphaned lease recovered and job moved to dead letter",
      timestamp: minutesAgo(12),
    }),
    makeSystemEvent("job.throttled", {
      jobId: throttledJobId,
      queue: "critical",
      state: "throttled",
      message: "tenant-a-rate temporarily saturated",
      timestamp: minutesAgo(1),
    }),
    makeSystemEvent("job.started", {
      jobId: activeJobId,
      queue: "critical",
      state: "active",
      workerId: "worker-c",
      message: "lease claimed by worker-c",
      timestamp: secondsAgo(47),
    }),
  ];

  const inspections: Record<string, JobInspection> = {
    [deadJobId]: {
      job: jobs.find((job) => job.id === deadJobId)!,
      attempts: deadLetters[0].attempts ?? [],
      events: [
        { jobId: deadJobId, type: "job.enqueued", message: "job accepted into critical", occurredAt: minutesAgo(72) },
        { jobId: deadJobId, type: "job.started", message: "worker-b acquired lease-webhook-4", occurredAt: minutesAgo(30) },
        { jobId: deadJobId, type: "job.orphan_recovered", message: "scheduler reclaimed stale lease after heartbeat expiry", occurredAt: minutesAgo(27) },
        { jobId: deadJobId, type: "job.started", message: "worker-b replayed recovered job with lease-webhook-5", occurredAt: minutesAgo(16) },
        { jobId: deadJobId, type: "job.failed", message: "remote 500 after 3 lease recoveries", occurredAt: minutesAgo(12) },
      ],
      graph: {
        rootJobId: deadJobId,
        nodes: [{ jobId: deadJobId, type: "webhook.dispatch", state: "failed", queue: "critical" }],
      },
      deadLetter: deadLetters[0],
      idempotency: null,
    },
    [thumbSmId]: {
      job: jobs.find((job) => job.id === thumbSmId)!,
      attempts: [
        {
          id: 61,
          jobId: thumbSmId,
          attempt: 1,
          workerId: "worker-a",
          leaseToken: "lease-thumb-sm",
          status: "active",
          leaseExpired: false,
          startedAt: minutesAgo(1),
        },
      ],
      events: [
        { jobId: thumbSmId, type: "job.enqueued", message: "fan-out branch released after file.ingest", occurredAt: minutesAgo(35) },
        { jobId: thumbSmId, type: "job.started", message: "lease owned by worker-a", occurredAt: minutesAgo(1) },
        { jobId: thumbSmId, type: "job.heartbeat", message: "lease renewal healthy", occurredAt: secondsAgo(4) },
      ],
      graph: {
        rootJobId: ingestId,
        nodes: [
          { jobId: ingestId, type: "file.ingest", state: "completed", queue: "default", workflowId },
          { jobId: thumbSmId, type: "image.thumbnail", state: "active", queue: "default", workflowId, parentJobId: ingestId, dependsOn: [ingestId], dependents: [aggregateId] },
          { jobId: thumbMdId, type: "image.thumbnail", state: "blocked", queue: "default", workflowId, parentJobId: ingestId, dependsOn: [ingestId], dependents: [aggregateId] },
          { jobId: aggregateId, type: "metadata.aggregate", state: "retrying", queue: "critical", workflowId, parentJobId: ingestId, dependsOn: [thumbSmId, thumbMdId], dependents: [] },
        ],
      },
      deadLetter: null,
      idempotency: null,
    },
    [idempotentJobId]: {
      job: jobs.find((job) => job.id === idempotentJobId)!,
      attempts: [
        {
          id: 71,
          jobId: idempotentJobId,
          attempt: 1,
          workerId: "worker-a",
          status: "completed",
          leaseExpired: false,
          startedAt: minutesAgo(18),
          finishedAt: minutesAgo(17),
        },
      ],
      events: [
        { jobId: idempotentJobId, type: "job.enqueued", message: "job accepted into default", occurredAt: minutesAgo(19) },
        { jobId: idempotentJobId, type: "job.completed", message: "notification delivered", occurredAt: minutesAgo(17) },
        { jobId: idempotentJobId, type: "job.duplicate_suppressed", message: "duplicate submission suppressed for invoice-ready:2026-03-12:42", occurredAt: minutesAgo(16) },
      ],
      graph: {
        rootJobId: idempotentJobId,
        nodes: [{ jobId: idempotentJobId, type: "email.send", state: "completed", queue: "default" }],
      },
      idempotency: {
        scope: "tenant-a:email.send:invoice-ready:2026-03-12:42",
        tenantId: "tenant-a",
        jobType: "email.send",
        idempotencyKey: "invoice-ready:2026-03-12:42",
        jobId: idempotentJobId,
        status: "completed",
        firstSeenAt: minutesAgo(19),
        updatedAt: minutesAgo(16),
        expiresAt: minutesAgo(-6),
      },
      deadLetter: null,
    },
  };

  const data: ConsoleData = {
    snapshot,
    jobs,
    schedules,
    events,
    workerStatuses,
    inspections,
    queueControls: {},
    workerControls: {},
    lastHydratedAt: new Date().toISOString(),
    source: "demo",
  };

  return reconcileConsoleData(data);
}

function summarizeJobs(jobs: Job[], workers: WorkerLeaseHealth[], rateLimits: RateLimitStatus[]) {
  const queueLengths = Object.fromEntries(QUEUES.map((queue) => [queue, 0])) as Record<string, number>;
  const summary = {
    totalJobs: jobs.length,
    queuedJobs: 0,
    blockedJobs: 0,
    throttledJobs: 0,
    activeJobs: 0,
    failedJobs: 0,
    retryingJobs: 0,
    completedJobs: 0,
    scheduledJobs: 0,
    canceledJobs: 0,
    queueLengths,
    averageExecMs: 0,
    activeWorkers: workers.length,
    delayedBacklog: 0,
  };

  const completed = jobs.filter((job) => job.executionMs > 0);
  summary.averageExecMs = completed.length > 0 ? completed.reduce((total, job) => total + job.executionMs, 0) / completed.length : 0;

  for (const job of jobs) {
    queueLengths[job.queue] = (queueLengths[job.queue] ?? 0) + (["queued", "retrying", "scheduled"].includes(job.state) ? 1 : 0);
    switch (job.state as JobState) {
      case "queued":
        summary.queuedJobs += 1;
        break;
      case "blocked":
        summary.blockedJobs += 1;
        break;
      case "throttled":
        summary.throttledJobs += 1;
        break;
      case "active":
        summary.activeJobs += 1;
        break;
      case "failed":
        summary.failedJobs += 1;
        break;
      case "retrying":
        summary.retryingJobs += 1;
        break;
      case "completed":
        summary.completedJobs += 1;
        break;
      case "scheduled":
        summary.scheduledJobs += 1;
        break;
      case "canceled":
        summary.canceledJobs += 1;
        break;
    }
    if (job.state === "scheduled" || job.state === "retrying") {
      summary.delayedBacklog += 1;
    }
  }

  if (rateLimits.some((item) => item.throttled)) {
    summary.throttledJobs = Math.max(summary.throttledJobs, jobs.filter((job) => job.state === "throttled").length);
  }

  return summary;
}

export function findDeadLetter(data: ConsoleData, jobId: string) {
  return data.snapshot.deadLetters.find((item) => item.jobId === jobId) ?? null;
}

export function appendEvent(data: ConsoleData, event: SystemEvent) {
  return appendEvents(data, [event]);
}

export function appendEvents(data: ConsoleData, events: SystemEvent[]) {
  if (events.length === 0) {
    return data;
  }

  const seen = new Set(data.events.map(createEventFingerprint));
  const merged = [...data.events];
  let changed = false;

  for (const event of events) {
    const fingerprint = createEventFingerprint(event);
    if (seen.has(fingerprint)) {
      continue;
    }
    seen.add(fingerprint);
    merged.push(event);
    changed = true;
  }

  if (!changed) {
    return data;
  }

  return {
    ...data,
    events: sortEvents(merged),
  };
}

export function replaceJob(data: ConsoleData, job: Job) {
  const nextJobs = data.jobs.some((candidate) => candidate.id === job.id)
    ? data.jobs.map((candidate) => (candidate.id === job.id ? job : candidate))
    : [job, ...data.jobs];
  return reconcileConsoleData({
    ...data,
    jobs: nextJobs,
  });
}

export function removeDeadLetters(data: ConsoleData, jobIds: string[]) {
  return reconcileConsoleData({
    ...data,
    snapshot: {
      ...data.snapshot,
      deadLetters: data.snapshot.deadLetters.filter((item) => !jobIds.includes(item.jobId)),
    },
  });
}

export function addLocalWorkflowJobs(data: ConsoleData) {
  const workflowId = `wf-${createToastId()}`;
  const rootId = createToastId();
  const rootJob: Job = {
    id: rootId,
    type: "file.ingest",
    queue: "default",
    tenantId: "tenant-a",
    payload: { fileId: workflowId, source: "s3://demo/new-asset.png", durationMs: 300 },
    priority: 6,
    attempts: 0,
    maxAttempts: 5,
    state: "queued",
    schemaVersion: 1,
    workflowId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    runAt: new Date().toISOString(),
    timeoutSeconds: 45,
    cancelRequested: false,
    executionMs: 0,
  };
  const children = ["sm", "md", "lg"].map((size) => ({
    id: createToastId(),
    type: "image.thumbnail",
    queue: "default",
    tenantId: "tenant-a",
    payload: { fileId: workflowId, size, durationMs: 250 },
    priority: 5,
    attempts: 0,
    maxAttempts: 5,
    state: "blocked" as JobState,
    schemaVersion: 1,
    workflowId,
    parentJobId: rootId,
    dependencyPolicy: "block",
    blockedReason: "waiting on root ingest",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    runAt: new Date().toISOString(),
    timeoutSeconds: 45,
    cancelRequested: false,
    executionMs: 0,
  }));

  return reconcileConsoleData({
    ...data,
    jobs: [rootJob, ...children, ...data.jobs],
    events: [makeSystemEvent("workflow.seeded", { message: `seeded ${workflowId}` }), ...data.events],
  });
}

export function createInspectionGraphForWorkflow(job: Job, jobs: Job[]): DependencyGraph {
  const nodes = jobs
    .filter((candidate) => candidate.workflowId && candidate.workflowId === job.workflowId)
    .map((candidate) => ({
      jobId: candidate.id,
      type: candidate.type,
      state: candidate.state,
      queue: candidate.queue,
      parentJobId: candidate.parentJobId,
      workflowId: candidate.workflowId,
      blockedReason: candidate.blockedReason,
    }));
  return {
    rootJobId: job.id,
    nodes: nodes.length > 0 ? nodes : [{ jobId: job.id, type: job.type, state: job.state, queue: job.queue }],
  };
}

function sortEvents(events: SystemEvent[]) {
  return [...events].sort((left, right) => new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime()).slice(0, 60);
}

function reuseList<T>(
  previous: T[],
  next: T[],
  getKey: (item: T, index: number) => string,
) {
  const previousByKey = new Map(previous.map((item, index) => [getKey(item, index), item]));
  let changed = previous.length !== next.length;

  const resolved = next.map((item, index) => {
    const existing = previousByKey.get(getKey(item, index));
    if (existing && sameValue(existing, item)) {
      return existing;
    }
    changed = true;
    return item;
  });

  return changed ? resolved : previous;
}

function reuseValue<T>(previous: T, next: T) {
  return sameValue(previous, next) ? previous : next;
}

function sameValue(left: unknown, right: unknown) {
  return stableSerialize(left) === stableSerialize(right);
}
