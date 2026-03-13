package bootstrap

import (
	"context"
	"log/slog"
	"time"

	"distributed-job-system/libs/backend/queue"
	"distributed-job-system/libs/backend/store"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

func ConnectPostgres(ctx context.Context, postgresURL string, log *slog.Logger) (*pgxpool.Pool, error) {
	for {
		pool, err := store.NewPool(ctx, postgresURL)
		if err == nil {
			pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			err = pool.Ping(pingCtx)
			cancel()
			if err == nil {
				return pool, nil
			}
			pool.Close()
		}
		if err := waitOrCancel(ctx, 2*time.Second); err != nil {
			return nil, err
		}
		log.Warn("waiting for postgres", "error", err)
	}
}

func ConnectRedis(ctx context.Context, addr, password string, db int, log *slog.Logger) (*redis.Client, error) {
	for {
		client := queue.NewClient(addr, password, db)
		pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		err := client.Ping(pingCtx).Err()
		cancel()
		if err == nil {
			return client, nil
		}
		_ = client.Close()
		if err := waitOrCancel(ctx, 2*time.Second); err != nil {
			return nil, err
		}
		log.Warn("waiting for redis", "error", err)
	}
}

func waitOrCancel(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
