package domain

import (
	"encoding/json"
	"fmt"
	"time"
)

type IdempotencyRecord struct {
	Scope          string          `json:"scope"`
	TenantID       string          `json:"tenantId"`
	JobType        string          `json:"jobType"`
	IdempotencyKey string          `json:"idempotencyKey"`
	JobID          string          `json:"jobId"`
	Status         string          `json:"status"`
	Outcome        json.RawMessage `json:"outcome,omitempty"`
	FirstSeenAt    time.Time       `json:"firstSeenAt"`
	UpdatedAt      time.Time       `json:"updatedAt"`
	ExpiresAt      time.Time       `json:"expiresAt"`
}

type JobAttempt struct {
	ID           int64      `json:"id"`
	JobID        string     `json:"jobId"`
	Attempt      int        `json:"attempt"`
	WorkerID     string     `json:"workerId"`
	LeaseToken   string     `json:"leaseToken,omitempty"`
	Status       string     `json:"status"`
	ErrorType    string     `json:"errorType,omitempty"`
	ErrorMessage string     `json:"errorMessage,omitempty"`
	StackTrace   string     `json:"stackTrace,omitempty"`
	LeaseExpired bool       `json:"leaseExpired"`
	StartedAt    time.Time  `json:"startedAt"`
	FinishedAt   *time.Time `json:"finishedAt,omitempty"`
}

type DeadLetter struct {
	JobID          string       `json:"jobId"`
	Queue          string       `json:"queue"`
	WorkerID       string       `json:"workerId"`
	ErrorType      string       `json:"errorType,omitempty"`
	ErrorMessage   string       `json:"errorMessage"`
	StackTrace     string       `json:"stackTrace,omitempty"`
	FailedAt       time.Time    `json:"failedAt"`
	LastAttempt    int          `json:"lastAttempt"`
	ReplayCount    int          `json:"replayCount"`
	LastReplayedAt *time.Time   `json:"lastReplayedAt,omitempty"`
	Job            *Job         `json:"job,omitempty"`
	Attempts       []JobAttempt `json:"attempts,omitempty"`
}

type DeadLetterFilter struct {
	Queue     string
	ErrorType string
	Limit     int
}

type DeadLetterReplayRequest struct {
	JobIDs   []string        `json:"jobIds"`
	Queue    string          `json:"queue,omitempty"`
	Payload  json.RawMessage `json:"payload,omitempty"`
	Actor    string          `json:"actor,omitempty"`
	JobType  string          `json:"jobType,omitempty"`
	Priority *int            `json:"priority,omitempty"`
}

type DeadLetterDeleteRequest struct {
	JobIDs []string `json:"jobIds"`
	Actor  string   `json:"actor,omitempty"`
}

type DeadLetterAction struct {
	JobID         string          `json:"jobId"`
	Action        string          `json:"action"`
	Actor         string          `json:"actor"`
	FromQueue     string          `json:"fromQueue,omitempty"`
	ToQueue       string          `json:"toQueue,omitempty"`
	PayloadBefore json.RawMessage `json:"payloadBefore,omitempty"`
	PayloadAfter  json.RawMessage `json:"payloadAfter,omitempty"`
	OccurredAt    time.Time       `json:"occurredAt"`
}

type RateLimitMode string

const (
	RateLimitModeRate        RateLimitMode = "rate"
	RateLimitModeConcurrency RateLimitMode = "concurrency"
)

type RateLimitScope string

const (
	RateLimitScopeGlobal  RateLimitScope = "global"
	RateLimitScopeQueue   RateLimitScope = "queue"
	RateLimitScopeJobType RateLimitScope = "job_type"
	RateLimitScopeTenant  RateLimitScope = "tenant"
)

type RateLimitPolicy struct {
	ID            string         `json:"id"`
	Name          string         `json:"name"`
	Scope         RateLimitScope `json:"scope"`
	ScopeValue    string         `json:"scopeValue,omitempty"`
	Mode          RateLimitMode  `json:"mode"`
	Limit         int            `json:"limit"`
	WindowSeconds int            `json:"windowSeconds"`
	Burst         int            `json:"burst"`
	Enabled       bool           `json:"enabled"`
	CreatedAt     time.Time      `json:"createdAt"`
	UpdatedAt     time.Time      `json:"updatedAt"`
}

type ThrottleReason struct {
	PolicyID   string         `json:"policyId"`
	PolicyName string         `json:"policyName"`
	Scope      RateLimitScope `json:"scope"`
	Mode       RateLimitMode  `json:"mode"`
	RetryAt    time.Time      `json:"retryAt"`
	Message    string         `json:"message"`
}

type RateLimitStatus struct {
	Policy      RateLimitPolicy `json:"policy"`
	ActiveCount int             `json:"activeCount"`
	RecentCount int             `json:"recentCount"`
	Throttled   bool            `json:"throttled"`
}

type SchedulerLeaderStatus struct {
	SchedulerID     string     `json:"schedulerId"`
	Token           string     `json:"token,omitempty"`
	IsLeaderHealthy bool       `json:"isLeaderHealthy"`
	AcquiredAt      *time.Time `json:"acquiredAt,omitempty"`
	LastHeartbeatAt *time.Time `json:"lastHeartbeatAt,omitempty"`
	LeaseExpiresAt  *time.Time `json:"leaseExpiresAt,omitempty"`
}

type WorkerLeaseHealth struct {
	WorkerID         string     `json:"workerId"`
	Hostname         string     `json:"hostname"`
	Status           string     `json:"status"`
	Queues           []string   `json:"queues"`
	LastSeenAt       time.Time  `json:"lastSeenAt"`
	HeartbeatAgeMs   int64      `json:"heartbeatAgeMs"`
	ActiveLeaseCount int        `json:"activeLeaseCount"`
	OldestLeaseAgeMs int64      `json:"oldestLeaseAgeMs"`
	OldestLeaseJobID string     `json:"oldestLeaseJobId,omitempty"`
	Version          string     `json:"version"`
	StartedAt        time.Time  `json:"startedAt"`
	LeaseExpiresAt   *time.Time `json:"leaseExpiresAt,omitempty"`
}

type MetricsSeriesPoint struct {
	Timestamp time.Time `json:"timestamp"`
	Value     float64   `json:"value"`
}

type MetricsTrend struct {
	Throughput        []MetricsSeriesPoint `json:"throughput"`
	ExecutionP95Ms    []MetricsSeriesPoint `json:"executionP95Ms"`
	QueueLatencyP95Ms []MetricsSeriesPoint `json:"queueLatencyP95Ms"`
	RetryRate         []MetricsSeriesPoint `json:"retryRate"`
	DeadLetterRate    []MetricsSeriesPoint `json:"deadLetterRate"`
}

type LatencySummary struct {
	P50Ms float64 `json:"p50Ms"`
	P95Ms float64 `json:"p95Ms"`
	P99Ms float64 `json:"p99Ms"`
}

type MetricsSummary struct {
	JobsPerSecond           float64        `json:"jobsPerSecond"`
	RetryRate               float64        `json:"retryRate"`
	DeadLetterRate          float64        `json:"deadLetterRate"`
	ExecutionLatency        LatencySummary `json:"executionLatency"`
	QueueLatency            LatencySummary `json:"queueLatency"`
	MaxWorkerHeartbeatAgeMs int64          `json:"maxWorkerHeartbeatAgeMs"`
}

type DashboardSnapshot struct {
	Overview      JobOverview           `json:"overview"`
	Metrics       MetricsSummary        `json:"metrics"`
	Trend         MetricsTrend          `json:"trend"`
	Workers       []WorkerLeaseHealth   `json:"workers"`
	DeadLetters   []DeadLetter          `json:"deadLetters"`
	BlockedJobs   []Job                 `json:"blockedJobs"`
	ThrottledJobs []Job                 `json:"throttledJobs"`
	RateLimits    []RateLimitStatus     `json:"rateLimits"`
	Leader        SchedulerLeaderStatus `json:"leader"`
}

func IdempotencyScope(tenantID, jobType, key string) string {
	return fmt.Sprintf("%s:%s:%s", tenantID, jobType, key)
}

func (p RateLimitPolicy) Validate() error {
	if p.Name == "" {
		return fmt.Errorf("name is required")
	}
	if p.Limit <= 0 {
		return fmt.Errorf("limit must be greater than zero")
	}
	switch p.Scope {
	case RateLimitScopeGlobal, RateLimitScopeQueue, RateLimitScopeJobType, RateLimitScopeTenant:
	default:
		return fmt.Errorf("invalid scope %q", p.Scope)
	}
	switch p.Mode {
	case RateLimitModeRate:
		if p.WindowSeconds <= 0 {
			return fmt.Errorf("windowSeconds must be greater than zero for rate limits")
		}
	case RateLimitModeConcurrency:
		if p.WindowSeconds <= 0 {
			p.WindowSeconds = 30
		}
	default:
		return fmt.Errorf("invalid mode %q", p.Mode)
	}
	return nil
}
