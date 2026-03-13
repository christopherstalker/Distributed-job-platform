package domain

import (
	"encoding/json"
	"time"
)

type Schedule struct {
	ID             string          `json:"id"`
	Name           string          `json:"name"`
	CronExpression string          `json:"cronExpression"`
	Queue          string          `json:"queue"`
	Type           string          `json:"type"`
	Payload        json.RawMessage `json:"payload"`
	Priority       int             `json:"priority"`
	MaxAttempts    int             `json:"maxAttempts"`
	TimeoutSeconds int             `json:"timeoutSeconds"`
	Enabled        bool            `json:"enabled"`
	Timezone       string          `json:"timezone"`
	NextRunAt      time.Time       `json:"nextRunAt"`
	LastRunAt      *time.Time      `json:"lastRunAt,omitempty"`
	CreatedAt      time.Time       `json:"createdAt"`
	UpdatedAt      time.Time       `json:"updatedAt"`
}

type ScheduleRequest struct {
	Name           string          `json:"name"`
	CronExpression string          `json:"cronExpression"`
	Queue          string          `json:"queue"`
	Type           string          `json:"type"`
	Payload        json.RawMessage `json:"payload"`
	Priority       *int            `json:"priority,omitempty"`
	MaxAttempts    int             `json:"maxAttempts"`
	TimeoutSeconds int             `json:"timeoutSeconds"`
	Enabled        *bool           `json:"enabled,omitempty"`
	Timezone       string          `json:"timezone"`
}
