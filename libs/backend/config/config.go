package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

type Common struct {
	ServiceName           string
	HTTPAddr              string
	RedisAddr             string
	RedisPassword         string
	RedisDB               int
	PostgresURL           string
	AdminToken            string
	MigrationsDir         string
	LogLevel              string
	LeaseTTL              time.Duration
	HeartbeatInterval     time.Duration
	BaseRetryDelay        time.Duration
	MaxRetryDelay         time.Duration
	QueuePollInterval     time.Duration
	WorkerHeartbeatEvery  time.Duration
	DashboardOrigin       string
	DefaultDedupeWindow   time.Duration
	PolicyRefreshInterval time.Duration
}

type API struct {
	Common
	AutoMigrate bool
}

type Worker struct {
	Common
	WorkerID    string
	Hostname    string
	Queues      []string
	Concurrency int
	Version     string
}

type Scheduler struct {
	Common
	ActivationBatchSize int64
	RecoveryBatchSize   int64
	CronPollInterval    time.Duration
	SchedulerID         string
	LeadershipTTL       time.Duration
}

func LoadCommon(serviceName string) (Common, error) {
	cfg := Common{
		ServiceName:           serviceName,
		HTTPAddr:              getenv("HTTP_ADDR", ":8080"),
		RedisAddr:             getenv("REDIS_ADDR", "localhost:6379"),
		RedisPassword:         os.Getenv("REDIS_PASSWORD"),
		RedisDB:               getenvInt("REDIS_DB", 0),
		PostgresURL:           getenv("POSTGRES_URL", "postgres://postgres:postgres@localhost:55432/jobsystem?sslmode=disable"),
		AdminToken:            os.Getenv("ADMIN_TOKEN"),
		MigrationsDir:         getenv("MIGRATIONS_DIR", "./migrations"),
		LogLevel:              getenv("LOG_LEVEL", "info"),
		LeaseTTL:              getenvDuration("LEASE_TTL", 30*time.Second),
		HeartbeatInterval:     getenvDuration("HEARTBEAT_INTERVAL", 10*time.Second),
		BaseRetryDelay:        getenvDuration("BASE_RETRY_DELAY", 5*time.Second),
		MaxRetryDelay:         getenvDuration("MAX_RETRY_DELAY", 15*time.Minute),
		QueuePollInterval:     getenvDuration("QUEUE_POLL_INTERVAL", 250*time.Millisecond),
		WorkerHeartbeatEvery:  getenvDuration("WORKER_HEARTBEAT_EVERY", 5*time.Second),
		DashboardOrigin:       getenv("DASHBOARD_ORIGIN", "http://localhost:3000"),
		DefaultDedupeWindow:   getenvDuration("DEFAULT_DEDUPE_WINDOW", 15*time.Minute),
		PolicyRefreshInterval: getenvDuration("POLICY_REFRESH_INTERVAL", 5*time.Second),
	}
	if cfg.PostgresURL == "" {
		return Common{}, fmt.Errorf("POSTGRES_URL is required")
	}
	return cfg, nil
}

func LoadAPI() (API, error) {
	common, err := LoadCommon("api")
	if err != nil {
		return API{}, err
	}
	return API{
		Common:      common,
		AutoMigrate: getenvBool("AUTO_MIGRATE", true),
	}, nil
}

func LoadWorker() (Worker, error) {
	common, err := LoadCommon("worker")
	if err != nil {
		return Worker{}, err
	}
	hostname, _ := os.Hostname()
	return Worker{
		Common:      common,
		WorkerID:    getenv("WORKER_ID", fmt.Sprintf("%s-%d", hostname, time.Now().UnixNano())),
		Hostname:    hostname,
		Queues:      splitCSV(getenv("WORKER_QUEUES", "critical,default,low")),
		Concurrency: getenvInt("WORKER_CONCURRENCY", 32),
		Version:     getenv("SERVICE_VERSION", "dev"),
	}, nil
}

func LoadScheduler() (Scheduler, error) {
	common, err := LoadCommon("scheduler")
	if err != nil {
		return Scheduler{}, err
	}
	return Scheduler{
		Common:              common,
		ActivationBatchSize: int64(getenvInt("SCHEDULER_ACTIVATION_BATCH", 500)),
		RecoveryBatchSize:   int64(getenvInt("SCHEDULER_RECOVERY_BATCH", 200)),
		CronPollInterval:    getenvDuration("CRON_POLL_INTERVAL", 15*time.Second),
		SchedulerID:         getenv("SCHEDULER_ID", fmt.Sprintf("scheduler-%d", time.Now().UnixNano())),
		LeadershipTTL:       getenvDuration("SCHEDULER_LEADERSHIP_TTL", 15*time.Second),
	}, nil
}

func getenv(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func getenvInt(key string, fallback int) int {
	if value := os.Getenv(key); value != "" {
		parsed, err := strconv.Atoi(value)
		if err == nil {
			return parsed
		}
	}
	return fallback
}

func getenvBool(key string, fallback bool) bool {
	if value := os.Getenv(key); value != "" {
		parsed, err := strconv.ParseBool(value)
		if err == nil {
			return parsed
		}
	}
	return fallback
}

func getenvDuration(key string, fallback time.Duration) time.Duration {
	if value := os.Getenv(key); value != "" {
		parsed, err := time.ParseDuration(value)
		if err == nil {
			return parsed
		}
	}
	return fallback
}

func splitCSV(value string) []string {
	parts := strings.Split(value, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		trimmed := strings.TrimSpace(part)
		if trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}
