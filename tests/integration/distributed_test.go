package integration

import (
	"context"
	"encoding/json"
	"log/slog"
	"testing"
	"time"

	"distributed-job-system/libs/backend/domain"
	"distributed-job-system/libs/backend/leadership"
	"distributed-job-system/libs/backend/limits"
	"distributed-job-system/libs/backend/metrics"
	"distributed-job-system/libs/backend/processors"
	"distributed-job-system/libs/backend/queue"
	schedulersvc "distributed-job-system/libs/backend/scheduler"
	"distributed-job-system/libs/backend/service"
	workerrt "distributed-job-system/libs/backend/worker"

	"github.com/alicebob/miniredis/v2"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/redis/go-redis/v9"
)

func TestDuplicateSubmissionSuppression(t *testing.T) {
	repo := newFakeRepo()
	broker := &fakeBroker{jobs: map[string]domain.Job{}}
	manager := service.NewManager(repo, broker, nil, nil, slog.Default())
	manager.DefaultDedupeWindow = time.Minute

	req := domain.JobRequest{
		Type:           "email.send",
		Queue:          "default",
		TenantID:       "tenant-a",
		IdempotencyKey: "email-123",
		SchemaVersion:  1,
		Payload:        service.JSON(map[string]any{"recipient": "ops@example.com"}),
	}

	first, err := manager.EnqueueJob(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	second, err := manager.EnqueueJob(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}

	if first.DuplicateSuppressed {
		t.Fatal("first enqueue should not be suppressed")
	}
	if !second.DuplicateSuppressed {
		t.Fatal("second enqueue should be suppressed")
	}
	if first.Job.ID != second.Job.ID {
		t.Fatalf("expected duplicate suppression to return %s, got %s", first.Job.ID, second.Job.ID)
	}
}

func TestDeadLetterReplay(t *testing.T) {
	repo := newFakeRepo()
	broker := &fakeBroker{jobs: map[string]domain.Job{}}
	manager := service.NewManager(repo, broker, nil, nil, slog.Default())

	now := time.Now().UTC()
	job := domain.Job{
		ID:            "11111111-1111-1111-1111-111111111111",
		Type:          "email.send",
		Queue:         "default",
		TenantID:      "tenant-a",
		Payload:       service.JSON(map[string]any{"recipient": "old@example.com"}),
		Priority:      5,
		State:         domain.JobStateFailed,
		MaxAttempts:   3,
		SchemaVersion: 1,
		CreatedAt:     now,
		UpdatedAt:     now,
		RunAt:         now,
	}
	repo.jobs[job.ID] = job
	repo.deadLetters[job.ID] = domain.DeadLetter{JobID: job.ID, Queue: job.Queue, FailedAt: now}
	broker.jobs[job.ID] = job

	replayed, err := manager.ReplayDeadLetters(context.Background(), domain.DeadLetterReplayRequest{
		JobIDs:  []string{job.ID},
		Queue:   "critical",
		Payload: service.JSON(map[string]any{"recipient": "new@example.com"}),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(replayed) != 1 {
		t.Fatalf("expected 1 replayed job, got %d", len(replayed))
	}
	if replayed[0].Queue != "critical" {
		t.Fatalf("expected queue override to apply, got %s", replayed[0].Queue)
	}
	if replayed[0].State != domain.JobStateQueued {
		t.Fatalf("expected queued replayed state, got %s", replayed[0].State)
	}
	if _, ok := repo.deadLetters[job.ID]; ok {
		t.Fatal("expected dead-letter record to be removed after replay")
	}
}

func TestLeaseExpirationTriggersOrphanRecovery(t *testing.T) {
	_, broker, closeRedis := newRedisBroker(t)
	defer closeRedis()

	repo := newFakeRepo()
	manager := service.NewManager(repo, broker, nil, nil, slog.Default())

	result, err := manager.EnqueueJob(context.Background(), domain.JobRequest{
		Type:           "cleanup.run",
		Queue:          "default",
		TenantID:       "tenant-a",
		SchemaVersion:  1,
		MaxAttempts:    3,
		Payload:        service.JSON(map[string]any{"message": "recover me"}),
		TimeoutSeconds: 1,
	})
	if err != nil {
		t.Fatal(err)
	}

	leased, err := broker.Dequeue(context.Background(), "worker-a", []string{"default"}, 300*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	if leased == nil {
		t.Fatal("expected leased job")
	}

	scheduler := &schedulersvc.Service{
		Repo:                repo,
		Broker:              broker,
		Log:                 slog.Default(),
		ActivationBatchSize: 1,
		RecoveryBatchSize:   10,
		ActivationInterval:  time.Hour,
		RecoveryInterval:    25 * time.Millisecond,
		CronPollInterval:    time.Hour,
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	go func() {
		_ = scheduler.Run(ctx)
	}()

	waitFor(t, 2*time.Second, func() bool {
		job := repo.jobs[result.Job.ID]
		return job.State == domain.JobStateRetrying
	})

	recovered, err := broker.LoadJob(context.Background(), result.Job.ID)
	if err != nil {
		t.Fatal(err)
	}
	if recovered.State != domain.JobStateRetrying {
		t.Fatalf("expected broker state retrying after orphan recovery, got %s", recovered.State)
	}
}

func TestDependencyUnlockBehavior(t *testing.T) {
	_, broker, closeRedis := newRedisBroker(t)
	defer closeRedis()

	repo := newFakeRepo()
	manager := service.NewManager(repo, broker, nil, nil, slog.Default())
	registry := processors.NewRegistry()
	processors.RegisterBuiltins(registry)

	parent, err := manager.EnqueueJob(context.Background(), domain.JobRequest{
		Type:          "file.ingest",
		Queue:         "default",
		TenantID:      "tenant-a",
		SchemaVersion: 1,
		Payload:       service.JSON(map[string]any{"fileId": "asset-1", "source": "s3://bucket/input.png"}),
	})
	if err != nil {
		t.Fatal(err)
	}
	child, err := manager.EnqueueJob(context.Background(), domain.JobRequest{
		Type:             "image.thumbnail",
		Queue:            "default",
		TenantID:         "tenant-a",
		SchemaVersion:    1,
		Dependencies:     []string{parent.Job.ID},
		DependencyPolicy: domain.DependencyFailurePolicyBlock,
		Payload:          service.JSON(map[string]any{"fileId": "asset-1", "size": "sm"}),
	})
	if err != nil {
		t.Fatal(err)
	}
	if child.Job.State != domain.JobStateBlocked {
		t.Fatalf("expected blocked child, got %s", child.Job.State)
	}

	runtime := &workerrt.Runtime{
		Repo:                  repo,
		Broker:                broker,
		Registry:              registry,
		Log:                   slog.Default(),
		WorkerStatus:          domain.WorkerStatus{WorkerID: "worker-a", Queues: []string{"default"}, Concurrency: 1},
		LeaseTTL:              500 * time.Millisecond,
		HeartbeatInterval:     100 * time.Millisecond,
		QueuePollInterval:     20 * time.Millisecond,
		BaseRetryDelay:        50 * time.Millisecond,
		MaxRetryDelay:         250 * time.Millisecond,
		PolicyRefreshInterval: time.Second,
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	go func() {
		_ = runtime.Run(ctx)
	}()

	waitFor(t, 2*time.Second, func() bool {
		return repo.jobs[child.Job.ID].State == domain.JobStateCompleted
	})

	if !hasEvent(repo.events[child.Job.ID], "job.unblocked") {
		t.Fatal("expected dependency unlock event for child job")
	}
}

func TestRateLimitEnforcement(t *testing.T) {
	client, broker, closeRedis := newRedisBroker(t)
	defer closeRedis()

	repo := newFakeRepo()
	repo.rateLimitPolicies = []domain.RateLimitPolicy{
		{
			ID:            "limit-email",
			Name:          "email-rate",
			Scope:         domain.RateLimitScopeJobType,
			ScopeValue:    "email.send",
			Mode:          domain.RateLimitModeRate,
			Limit:         1,
			WindowSeconds: 60,
			Enabled:       true,
		},
	}
	manager := service.NewManager(repo, broker, nil, nil, slog.Default())
	limiter := limits.NewRedisLimiter(client)
	registry := processors.NewRegistry()
	processors.RegisterBuiltins(registry)

	runtime := &workerrt.Runtime{
		Repo:                  repo,
		Broker:                broker,
		Registry:              registry,
		Log:                   slog.Default(),
		WorkerStatus:          domain.WorkerStatus{WorkerID: "worker-rate", Queues: []string{"default"}, Concurrency: 1},
		LeaseTTL:              500 * time.Millisecond,
		HeartbeatInterval:     100 * time.Millisecond,
		QueuePollInterval:     20 * time.Millisecond,
		BaseRetryDelay:        50 * time.Millisecond,
		MaxRetryDelay:         250 * time.Millisecond,
		PolicyRefreshInterval: 50 * time.Millisecond,
		Limiter:               limiter,
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	go func() {
		_ = runtime.Run(ctx)
	}()
	time.Sleep(100 * time.Millisecond)

	first, err := manager.EnqueueJob(context.Background(), domain.JobRequest{
		Type:          "email.send",
		Queue:         "default",
		TenantID:      "tenant-a",
		SchemaVersion: 1,
		Payload:       service.JSON(map[string]any{"recipient": "first@example.com"}),
	})
	if err != nil {
		t.Fatal(err)
	}
	second, err := manager.EnqueueJob(context.Background(), domain.JobRequest{
		Type:          "email.send",
		Queue:         "default",
		TenantID:      "tenant-a",
		SchemaVersion: 1,
		Payload:       service.JSON(map[string]any{"recipient": "second@example.com"}),
	})
	if err != nil {
		t.Fatal(err)
	}

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		stateA := repo.jobs[first.Job.ID].State
		stateB := repo.jobs[second.Job.ID].State
		if (stateA == domain.JobStateCompleted && stateB == domain.JobStateThrottled) ||
			(stateA == domain.JobStateThrottled && stateB == domain.JobStateCompleted) {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("expected completed/throttled states, got %s and %s", repo.jobs[first.Job.ID].State, repo.jobs[second.Job.ID].State)
}

func TestSchedulerLeaderFailover(t *testing.T) {
	server := miniredis.RunT(t)
	clientA := queue.NewClient(server.Addr(), "", 0)
	defer clientA.Close()
	clientB := queue.NewClient(server.Addr(), "", 0)
	defer clientB.Close()

	leaderA := leadership.NewRedisLeaderElector(clientA)
	leaderB := leadership.NewRedisLeaderElector(clientB)

	tokenA, acquiredA, err := leaderA.TryAcquire(context.Background(), "scheduler-a", 500*time.Millisecond, "")
	if err != nil {
		t.Fatal(err)
	}
	if !acquiredA {
		t.Fatal("expected first scheduler to acquire leadership")
	}

	if _, acquiredB, err := leaderB.TryAcquire(context.Background(), "scheduler-b", 500*time.Millisecond, ""); err != nil {
		t.Fatal(err)
	} else if acquiredB {
		t.Fatal("expected second scheduler to be denied while leader lease is active")
	}

	server.FastForward(750 * time.Millisecond)

	if _, acquiredB, err := leaderB.TryAcquire(context.Background(), "scheduler-b", 500*time.Millisecond, ""); err != nil {
		t.Fatal(err)
	} else if !acquiredB {
		t.Fatal("expected second scheduler to take over after failover")
	}

	status, err := leaderB.Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if status.SchedulerID != "scheduler-b" {
		t.Fatalf("expected scheduler-b to be leader, got %s (token %s)", status.SchedulerID, tokenA)
	}
}

func TestMetricsAndEventEmission(t *testing.T) {
	_, broker, closeRedis := newRedisBroker(t)
	defer closeRedis()

	repo := newFakeRepo()
	registry := prometheus.NewRegistry()
	metricSet := metrics.New(registry, "worker_test")
	manager := service.NewManager(repo, broker, nil, nil, slog.Default())
	processRegistry := processors.NewRegistry()
	processors.RegisterBuiltins(processRegistry)

	result, err := manager.EnqueueJob(context.Background(), domain.JobRequest{
		Type:          "cleanup.run",
		Queue:         "default",
		TenantID:      "tenant-a",
		SchemaVersion: 1,
		Payload:       service.JSON(map[string]any{"message": "metrics"}),
	})
	if err != nil {
		t.Fatal(err)
	}

	runtime := &workerrt.Runtime{
		Repo:                  repo,
		Broker:                broker,
		Registry:              processRegistry,
		Metrics:               metricSet,
		Log:                   slog.Default(),
		WorkerStatus:          domain.WorkerStatus{WorkerID: "worker-metrics", Queues: []string{"default"}, Concurrency: 1},
		LeaseTTL:              500 * time.Millisecond,
		HeartbeatInterval:     100 * time.Millisecond,
		QueuePollInterval:     20 * time.Millisecond,
		BaseRetryDelay:        50 * time.Millisecond,
		MaxRetryDelay:         250 * time.Millisecond,
		PolicyRefreshInterval: time.Second,
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	go func() {
		_ = runtime.Run(ctx)
	}()

	waitFor(t, 2*time.Second, func() bool {
		return repo.jobs[result.Job.ID].State == domain.JobStateCompleted
	})

	if testutil.ToFloat64(metricSet.StartedTotal) < 1 {
		t.Fatal("expected started metric to increment")
	}
	if testutil.ToFloat64(metricSet.CompletedTotal) < 1 {
		t.Fatal("expected completed metric to increment")
	}
	if !hasEvent(repo.events[result.Job.ID], "job.started") || !hasEvent(repo.events[result.Job.ID], "job.completed") {
		payload, _ := json.Marshal(repo.events[result.Job.ID])
		t.Fatalf("expected started/completed events, got %s", payload)
	}
}

func newRedisBroker(t *testing.T) (*redis.Client, *queue.RedisBroker, func()) {
	t.Helper()
	server := miniredis.RunT(t)
	client := queue.NewClient(server.Addr(), "", 0)
	broker := queue.NewRedisBroker(client, slog.Default(), 50*time.Millisecond, 250*time.Millisecond)
	return client, broker, func() {
		_ = client.Close()
		server.Close()
	}
}

func newFakeRepo() *fakeRepo {
	return &fakeRepo{
		jobs:               make(map[string]domain.Job),
		events:             make(map[string][]domain.JobEvent),
		attempts:           make(map[string][]domain.JobAttempt),
		dependencies:       make(map[string][]domain.JobDependency),
		deadLetters:        make(map[string]domain.DeadLetter),
		idempotencyRecords: make(map[string]domain.IdempotencyRecord),
	}
}

func waitFor(t *testing.T, timeout time.Duration, fn func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if fn() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("condition not met before timeout")
}

func hasEvent(events []domain.JobEvent, eventType string) bool {
	for _, event := range events {
		if event.Type == eventType {
			return true
		}
	}
	return false
}
