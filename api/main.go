package main

import (
	"context"
	"errors"
	"net/http"
	"os/signal"
	"syscall"
	"time"

	"distributed-job-system/libs/backend/bootstrap"
	"distributed-job-system/libs/backend/bus"
	"distributed-job-system/libs/backend/config"
	"distributed-job-system/libs/backend/httpapi"
	"distributed-job-system/libs/backend/leadership"
	"distributed-job-system/libs/backend/limits"
	"distributed-job-system/libs/backend/logging"
	"distributed-job-system/libs/backend/metrics"
	"distributed-job-system/libs/backend/queue"
	"distributed-job-system/libs/backend/schemas"
	"distributed-job-system/libs/backend/service"
	"distributed-job-system/libs/backend/store"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
)

func main() {
	cfg, err := config.LoadAPI()
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

	repo := store.NewPostgresRepository(pool, log)
	if cfg.AutoMigrate {
		if err := repo.RunMigrations(ctx, cfg.MigrationsDir); err != nil {
			log.Error("failed to run migrations", "error", err)
			return
		}
	}

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
	metricSet := metrics.New(registry, "api")
	broker := queue.NewRedisBroker(redisClient, log, cfg.BaseRetryDelay, cfg.MaxRetryDelay)
	eventBus := bus.NewRedisEventBus(redisClient)
	schemaRegistry := schemas.NewRegistry()
	schemas.RegisterBuiltins(schemaRegistry)
	leaderElector := leadership.NewRedisLeaderElector(redisClient)
	limiter := limits.NewRedisLimiter(redisClient)
	manager := service.NewManager(repo, broker, eventBus, metricSet, log)
	manager.Schemas = schemaRegistry
	manager.DefaultDedupeWindow = cfg.DefaultDedupeWindow
	manager.Leader = leaderElector
	manager.RateLimiter = limiter
	server := httpapi.NewServer(manager, eventBus, log, registry, cfg.AdminToken, cfg.DashboardOrigin)

	httpServer := &http.Server{
		Addr:    cfg.HTTPAddr,
		Handler: server.Handler(),
	}

	go func() {
		log.Info("api server listening", "addr", cfg.HTTPAddr)
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("api server failed", "error", err)
		}
	}()

	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		log.Error("api shutdown failed", "error", err)
	}
	log.Info("api server stopped")
}
