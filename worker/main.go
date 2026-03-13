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
	"distributed-job-system/libs/backend/domain"
	"distributed-job-system/libs/backend/limits"
	"distributed-job-system/libs/backend/logging"
	"distributed-job-system/libs/backend/metrics"
	"distributed-job-system/libs/backend/processors"
	"distributed-job-system/libs/backend/queue"
	"distributed-job-system/libs/backend/store"
	workersvc "distributed-job-system/libs/backend/worker"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

func main() {
	cfg, err := config.LoadWorker()
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
	metricSet := metrics.New(registry, "worker")
	repo := store.NewPostgresRepository(pool, log)
	broker := queue.NewRedisBroker(redisClient, log, cfg.BaseRetryDelay, cfg.MaxRetryDelay)
	eventBus := bus.NewRedisEventBus(redisClient)
	limiter := limits.NewRedisLimiter(redisClient)
	processorRegistry := processors.NewRegistry()
	processors.RegisterBuiltins(processorRegistry)

	runtime := &workersvc.Runtime{
		Repo:     repo,
		Broker:   broker,
		Bus:      eventBus,
		Registry: processorRegistry,
		Metrics:  metricSet,
		Log:      log,
		LeaseTTL: cfg.LeaseTTL,
		Limiter:  limiter,
		WorkerStatus: domain.WorkerStatus{
			WorkerID:    cfg.WorkerID,
			Hostname:    cfg.Hostname,
			Queues:      cfg.Queues,
			Concurrency: cfg.Concurrency,
			Status:      "starting",
			Version:     cfg.Version,
		},
		HeartbeatInterval:     cfg.HeartbeatInterval,
		QueuePollInterval:     cfg.QueuePollInterval,
		BaseRetryDelay:        cfg.BaseRetryDelay,
		MaxRetryDelay:         cfg.MaxRetryDelay,
		PolicyRefreshInterval: cfg.PolicyRefreshInterval,
	}

	go serveMetrics(cfg.HTTPAddr, registry)
	if err := runtime.Run(ctx); err != nil {
		log.Error("worker runtime failed", "error", err)
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
