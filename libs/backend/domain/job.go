package domain

import (
	"encoding/json"
	"fmt"
	"math"
	"time"
)

type JobState string

const (
	JobStateQueued    JobState = "queued"
	JobStateScheduled JobState = "scheduled"
	JobStateRetrying  JobState = "retrying"
	JobStateBlocked   JobState = "blocked"
	JobStateThrottled JobState = "throttled"
	JobStateActive    JobState = "active"
	JobStateCompleted JobState = "completed"
	JobStateFailed    JobState = "failed"
	JobStateCanceled  JobState = "canceled"
)

var SupportedQueues = []string{"critical", "default", "low"}
var SupportedPriorities = []int{9, 6, 3, 0}

type Job struct {
	ID               string                  `json:"id"`
	Type             string                  `json:"type"`
	Queue            string                  `json:"queue"`
	TenantID         string                  `json:"tenantId"`
	Payload          json.RawMessage         `json:"payload"`
	Priority         int                     `json:"priority"`
	Attempts         int                     `json:"attempts"`
	MaxAttempts      int                     `json:"maxAttempts"`
	State            JobState                `json:"state"`
	SchemaVersion    int                     `json:"schemaVersion"`
	IdempotencyKey   string                  `json:"idempotencyKey,omitempty"`
	WorkflowID       string                  `json:"workflowId,omitempty"`
	ParentJobID      string                  `json:"parentJobId,omitempty"`
	DependencyPolicy DependencyFailurePolicy `json:"dependencyPolicy,omitempty"`
	BlockedReason    string                  `json:"blockedReason,omitempty"`
	CreatedAt        time.Time               `json:"createdAt"`
	UpdatedAt        time.Time               `json:"updatedAt"`
	RunAt            time.Time               `json:"runAt"`
	StartedAt        *time.Time              `json:"startedAt,omitempty"`
	FinishedAt       *time.Time              `json:"finishedAt,omitempty"`
	LastHeartbeatAt  *time.Time              `json:"lastHeartbeatAt,omitempty"`
	LeaseExpiresAt   *time.Time              `json:"leaseExpiresAt,omitempty"`
	ThrottleUntil    *time.Time              `json:"throttleUntil,omitempty"`
	LastError        string                  `json:"lastError,omitempty"`
	Result           json.RawMessage         `json:"result,omitempty"`
	WorkerID         string                  `json:"workerId,omitempty"`
	LeaseToken       string                  `json:"leaseToken,omitempty"`
	TimeoutSeconds   int                     `json:"timeoutSeconds"`
	CancelRequested  bool                    `json:"cancelRequested"`
	ExecutionMs      int64                   `json:"executionMs"`
}

type JobRequest struct {
	Type                string                  `json:"type"`
	Queue               string                  `json:"queue"`
	TenantID            string                  `json:"tenantId"`
	Payload             json.RawMessage         `json:"payload"`
	Priority            *int                    `json:"priority,omitempty"`
	MaxAttempts         int                     `json:"maxAttempts"`
	DelaySeconds        int                     `json:"delaySeconds"`
	ScheduledAt         *time.Time              `json:"scheduledAt,omitempty"`
	TimeoutSeconds      int                     `json:"timeoutSeconds"`
	SchemaVersion       int                     `json:"schemaVersion"`
	IdempotencyKey      string                  `json:"idempotencyKey,omitempty"`
	DedupeWindowSeconds int                     `json:"dedupeWindowSeconds"`
	Dependencies        []string                `json:"dependencies,omitempty"`
	DependencyPolicy    DependencyFailurePolicy `json:"dependencyPolicy,omitempty"`
	WorkflowID          string                  `json:"workflowId,omitempty"`
	ParentJobID         string                  `json:"parentJobId,omitempty"`
}

type BatchEnqueueRequest struct {
	Jobs []JobRequest `json:"jobs"`
}

type ListJobsFilter struct {
	State      JobState
	Queue      string
	Worker     string
	TenantID   string
	WorkflowID string
	Limit      int
}

type JobOverview struct {
	TotalJobs      int64            `json:"totalJobs"`
	QueuedJobs     int64            `json:"queuedJobs"`
	BlockedJobs    int64            `json:"blockedJobs"`
	ThrottledJobs  int64            `json:"throttledJobs"`
	ActiveJobs     int64            `json:"activeJobs"`
	FailedJobs     int64            `json:"failedJobs"`
	RetryingJobs   int64            `json:"retryingJobs"`
	CompletedJobs  int64            `json:"completedJobs"`
	ScheduledJobs  int64            `json:"scheduledJobs"`
	CanceledJobs   int64            `json:"canceledJobs"`
	QueueLengths   map[string]int64 `json:"queueLengths"`
	AverageExecMs  float64          `json:"averageExecMs"`
	LastUpdatedAt  time.Time        `json:"lastUpdatedAt"`
	ActiveWorkers  int64            `json:"activeWorkers"`
	DelayedBacklog int64            `json:"delayedBacklog"`
}

type JobEvent struct {
	JobID      string          `json:"jobId"`
	Type       string          `json:"type"`
	Message    string          `json:"message"`
	Metadata   json.RawMessage `json:"metadata,omitempty"`
	OccurredAt time.Time       `json:"occurredAt"`
}

type LeasedJob struct {
	Job
	LeaseToken string `json:"leaseToken"`
}

type EnqueueResult struct {
	Job                 Job                `json:"job"`
	DuplicateSuppressed bool               `json:"duplicateSuppressed"`
	Idempotency         *IdempotencyRecord `json:"idempotency,omitempty"`
}

type WorkerStatus struct {
	WorkerID    string    `json:"workerId"`
	Hostname    string    `json:"hostname"`
	Queues      []string  `json:"queues"`
	Concurrency int       `json:"concurrency"`
	Status      string    `json:"status"`
	StartedAt   time.Time `json:"startedAt"`
	LastSeenAt  time.Time `json:"lastSeenAt"`
	Version     string    `json:"version"`
}

type SystemEvent struct {
	Kind       string        `json:"kind"`
	JobID      string        `json:"jobId,omitempty"`
	Queue      string        `json:"queue,omitempty"`
	WorkerID   string        `json:"workerId,omitempty"`
	State      JobState      `json:"state,omitempty"`
	Message    string        `json:"message,omitempty"`
	Timestamp  time.Time     `json:"timestamp"`
	Overview   *JobOverview  `json:"overview,omitempty"`
	WorkerInfo *WorkerStatus `json:"workerInfo,omitempty"`
}

type FailureDisposition struct {
	RetryAt  *time.Time
	Dead     bool
	Backoff  time.Duration
	Attempts int
}

func (r JobRequest) Validate() error {
	if r.Type == "" {
		return fmt.Errorf("type is required")
	}
	if r.Queue == "" {
		r.Queue = "default"
	}
	if r.TenantID == "" {
		r.TenantID = "default"
	}
	if r.Priority != nil && (*r.Priority < 0 || *r.Priority > 9) {
		return fmt.Errorf("priority must be between 0 and 9")
	}
	if r.MaxAttempts < 0 {
		return fmt.Errorf("maxAttempts cannot be negative")
	}
	if r.TimeoutSeconds < 0 {
		return fmt.Errorf("timeoutSeconds cannot be negative")
	}
	if r.DedupeWindowSeconds < 0 {
		return fmt.Errorf("dedupeWindowSeconds cannot be negative")
	}
	if r.SchemaVersion < 0 {
		return fmt.Errorf("schemaVersion cannot be negative")
	}
	if err := r.DependencyPolicy.Validate(); err != nil {
		return err
	}
	return nil
}

func NormalizeQueue(queue string) string {
	if queue == "" {
		return "default"
	}
	return queue
}

func ComputeBackoff(attempt int, base time.Duration, capDelay time.Duration) time.Duration {
	if attempt <= 0 {
		return base
	}
	backoff := float64(base) * math.Pow(2, float64(attempt-1))
	if time.Duration(backoff) > capDelay {
		return capDelay
	}
	return time.Duration(backoff)
}
