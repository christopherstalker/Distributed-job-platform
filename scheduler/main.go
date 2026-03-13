package main

import (
	"context"
	"errors"
	"net/http"
	"os/signal"
	"syscall"

	"distributed-job-system/libs/backend/bootstrap"
	"distributed-job-system/libs/backend/bus"
	"distributed-job-system/libs/backend/config"
	"distributed-job-system/libs/backend/leadership"
	"distributed-job-system/libs/backend/logging"
	"distributed-job-system/libs/backend/metrics"
	"distributed-job-system/libs/backend/queue"
	schedulersvc "distributed-job-system/libs/backend/scheduler"
	"distributed-job-system/libs/backend/schemas"
	"distributed-job-system/libs/backend/service"
	"distributed-job-system/libs/backend/store"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

func main() {
	cfg, err := config.LoadScheduler()
	if err != nil {
		panic(err)
	}
	log := logging.New(cfg.LogLevel)
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	pool, err := bootstrap.ConnectPostgres(ctx, cfg.PostgresURL, log)
	if err != nil {
		log.Error("failed to connect postgres", "error", err)
		return
	}
	defer pool.Close()

	redisClient, err := bootstrap.ConnectRedis(ctx, cfg.RedisAddr, cfg.RedisPassword, cfg.RedisDB, log)
	if err != nil {
		log.Error("failed to connect redis", "error", err)
		return
	}
	defer redisClient.Close()

	registry := prometheus.NewRegistry()
	registry.MustRegister(
		collectors.NewGoCollector(),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
	)
	metricSet := metrics.New(registry, "scheduler")
	repo := store.NewPostgresRepository(pool, log)
	broker := queue.NewRedisBroker(redisClient, log, cfg.BaseRetryDelay, cfg.MaxRetryDelay)
	eventBus := bus.NewRedisEventBus(redisClient)
	leaderElector := leadership.NewRedisLeaderElector(redisClient)
	schemaRegistry := schemas.NewRegistry()
	schemas.RegisterBuiltins(schemaRegistry)
	manager := service.NewManager(repo, broker, eventBus, metricSet, log)
	manager.Schemas = schemaRegistry
	manager.DefaultDedupeWindow = cfg.DefaultDedupeWindow

	svc := &schedulersvc.Service{
		Repo:                repo,
		Broker:              broker,
		Bus:                 eventBus,
		Enqueuer:            manager,
		Metrics:             metricSet,
		Log:                 log,
		ActivationBatchSize: cfg.ActivationBatchSize,
		RecoveryBatchSize:   cfg.RecoveryBatchSize,
		ActivationInterval:  1 * cfg.QueuePollInterval,
		RecoveryInterval:    cfg.HeartbeatInterval,
		CronPollInterval:    cfg.CronPollInterval,
		SchedulerID:         cfg.SchedulerID,
		LeadershipTTL:       cfg.LeadershipTTL,
		Leader:              leaderElector,
	}

	go serveMetrics(cfg.HTTPAddr, registry)
	if err := svc.Run(ctx); err != nil {
		log.Error("scheduler runtime failed", "error", err)
	}
}

func serveMetrics(addr string, registry *prometheus.Registry) {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.HandlerFor(registry, promhttp.HandlerOpts{}))
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	server := &http.Server{Addr: addr, Handler: mux}
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		panic(err)
	}
}
