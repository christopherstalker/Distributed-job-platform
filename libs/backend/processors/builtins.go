package processors

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand/v2"
	"time"

	"distributed-job-system/libs/backend/domain"
)

type simulatedPayload struct {
	DurationMs int    `json:"durationMs"`
	Recipient  string `json:"recipient"`
	ReportID   string `json:"reportId"`
	ForceError bool   `json:"forceError"`
	Message    string `json:"message"`
	FileID     string `json:"fileId"`
	Source     string `json:"source"`
	Size       string `json:"size"`
	UserID     string `json:"userId"`
	Channel    string `json:"channel"`
}

func RegisterBuiltins(registry *Registry) {
	registry.Register("email.send", HandlerFunc(func(ctx context.Context, job domain.Job) (json.RawMessage, error) {
		var payload simulatedPayload
		_ = json.Unmarshal(job.Payload, &payload)
		if payload.DurationMs <= 0 {
			payload.DurationMs = 250
		}
		if err := sleepWithContext(ctx, time.Duration(payload.DurationMs)*time.Millisecond); err != nil {
			return nil, err
		}
		if payload.ForceError {
			return nil, errors.New("simulated SMTP failure")
		}
		return marshalResult(map[string]any{
			"provider":  "smtp",
			"recipient": payload.Recipient,
			"status":    "accepted",
		})
	}))

	registry.Register("report.generate", HandlerFunc(func(ctx context.Context, job domain.Job) (json.RawMessage, error) {
		var payload simulatedPayload
		_ = json.Unmarshal(job.Payload, &payload)
		if payload.DurationMs <= 0 {
			payload.DurationMs = 1000
		}
		if err := sleepWithContext(ctx, time.Duration(payload.DurationMs)*time.Millisecond); err != nil {
			return nil, err
		}
		if payload.ForceError {
			return nil, errors.New("simulated report rendering failure")
		}
		return marshalResult(map[string]any{
			"reportId": payload.ReportID,
			"artifact": fmt.Sprintf("s3://reports/%s.pdf", payload.ReportID),
			"rows":     rand.IntN(5000) + 250,
		})
	}))

	registry.Register("cleanup.run", HandlerFunc(func(ctx context.Context, job domain.Job) (json.RawMessage, error) {
		var payload simulatedPayload
		_ = json.Unmarshal(job.Payload, &payload)
		if payload.DurationMs <= 0 {
			payload.DurationMs = 150
		}
		if err := sleepWithContext(ctx, time.Duration(payload.DurationMs)*time.Millisecond); err != nil {
			return nil, err
		}
		return marshalResult(map[string]any{
			"status":  "ok",
			"message": payload.Message,
		})
	}))

	registry.Register("webhook.dispatch", HandlerFunc(func(ctx context.Context, job domain.Job) (json.RawMessage, error) {
		var payload simulatedPayload
		_ = json.Unmarshal(job.Payload, &payload)
		if payload.DurationMs <= 0 {
			payload.DurationMs = 400
		}
		if err := sleepWithContext(ctx, time.Duration(payload.DurationMs)*time.Millisecond); err != nil {
			return nil, err
		}
		if payload.ForceError {
			return nil, errors.New("simulated 500 from downstream webhook")
		}
		return marshalResult(map[string]any{
			"status": "delivered",
		})
	}))

	registry.Register("file.ingest", HandlerFunc(func(ctx context.Context, job domain.Job) (json.RawMessage, error) {
		var payload simulatedPayload
		_ = json.Unmarshal(job.Payload, &payload)
		if payload.DurationMs <= 0 {
			payload.DurationMs = 300
		}
		if err := sleepWithContext(ctx, time.Duration(payload.DurationMs)*time.Millisecond); err != nil {
			return nil, err
		}
		if payload.ForceError {
			return nil, errors.New("simulated ingest failure")
		}
		return marshalResult(map[string]any{
			"fileId": payload.FileID,
			"source": payload.Source,
			"status": "ingested",
		})
	}))

	registry.Register("image.thumbnail", HandlerFunc(func(ctx context.Context, job domain.Job) (json.RawMessage, error) {
		var payload simulatedPayload
		_ = json.Unmarshal(job.Payload, &payload)
		if payload.DurationMs <= 0 {
			payload.DurationMs = 200
		}
		if err := sleepWithContext(ctx, time.Duration(payload.DurationMs)*time.Millisecond); err != nil {
			return nil, err
		}
		if payload.ForceError {
			return nil, errors.New("simulated thumbnail failure")
		}
		return marshalResult(map[string]any{
			"fileId": payload.FileID,
			"size":   payload.Size,
			"asset":  fmt.Sprintf("s3://thumbnails/%s-%s.png", payload.FileID, payload.Size),
		})
	}))

	registry.Register("metadata.aggregate", HandlerFunc(func(ctx context.Context, job domain.Job) (json.RawMessage, error) {
		var payload simulatedPayload
		_ = json.Unmarshal(job.Payload, &payload)
		if payload.DurationMs <= 0 {
			payload.DurationMs = 350
		}
		if err := sleepWithContext(ctx, time.Duration(payload.DurationMs)*time.Millisecond); err != nil {
			return nil, err
		}
		if payload.ForceError {
			return nil, errors.New("simulated metadata aggregation failure")
		}
		return marshalResult(map[string]any{
			"fileId": payload.FileID,
			"status": "aggregated",
		})
	}))

	registry.Register("user.notify", HandlerFunc(func(ctx context.Context, job domain.Job) (json.RawMessage, error) {
		var payload simulatedPayload
		_ = json.Unmarshal(job.Payload, &payload)
		if payload.DurationMs <= 0 {
			payload.DurationMs = 125
		}
		if err := sleepWithContext(ctx, time.Duration(payload.DurationMs)*time.Millisecond); err != nil {
			return nil, err
		}
		if payload.ForceError {
			return nil, errors.New("simulated notification failure")
		}
		return marshalResult(map[string]any{
			"userId":  payload.UserID,
			"channel": payload.Channel,
			"status":  "sent",
		})
	}))
}

func sleepWithContext(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func marshalResult(value any) (json.RawMessage, error) {
	payload, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	return payload, nil
}
