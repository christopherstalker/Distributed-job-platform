package schemas

import (
	"encoding/json"
	"fmt"
)

type emailPayload struct {
	Recipient string `json:"recipient"`
}

type reportPayload struct {
	ReportID string `json:"reportId"`
}

type fileIngestPayload struct {
	FileID string `json:"fileId"`
	Source string `json:"source"`
}

type thumbnailPayload struct {
	FileID string `json:"fileId"`
	Size   string `json:"size"`
}

type aggregatePayload struct {
	FileID string `json:"fileId"`
}

type notifyPayload struct {
	UserID  string `json:"userId"`
	Channel string `json:"channel"`
}

func RegisterBuiltins(registry *Registry) {
	registry.Register("email.send", 1, func(payload json.RawMessage) error {
		var value emailPayload
		if err := json.Unmarshal(payload, &value); err != nil {
			return err
		}
		if value.Recipient == "" {
			return fmt.Errorf("recipient is required")
		}
		return nil
	})
	registry.Register("report.generate", 1, func(payload json.RawMessage) error {
		var value reportPayload
		if err := json.Unmarshal(payload, &value); err != nil {
			return err
		}
		if value.ReportID == "" {
			return fmt.Errorf("reportId is required")
		}
		return nil
	})
	registry.Register("cleanup.run", 1, func(payload json.RawMessage) error {
		if len(payload) == 0 {
			return nil
		}
		var value map[string]any
		return json.Unmarshal(payload, &value)
	})
	registry.Register("webhook.dispatch", 1, func(payload json.RawMessage) error {
		if len(payload) == 0 {
			return nil
		}
		var value map[string]any
		return json.Unmarshal(payload, &value)
	})
	registry.Register("file.ingest", 1, func(payload json.RawMessage) error {
		var value fileIngestPayload
		if err := json.Unmarshal(payload, &value); err != nil {
			return err
		}
		if value.FileID == "" || value.Source == "" {
			return fmt.Errorf("fileId and source are required")
		}
		return nil
	})
	registry.Register("image.thumbnail", 1, func(payload json.RawMessage) error {
		var value thumbnailPayload
		if err := json.Unmarshal(payload, &value); err != nil {
			return err
		}
		if value.FileID == "" || value.Size == "" {
			return fmt.Errorf("fileId and size are required")
		}
		return nil
	})
	registry.Register("metadata.aggregate", 1, func(payload json.RawMessage) error {
		var value aggregatePayload
		if err := json.Unmarshal(payload, &value); err != nil {
			return err
		}
		if value.FileID == "" {
			return fmt.Errorf("fileId is required")
		}
		return nil
	})
	registry.Register("user.notify", 1, func(payload json.RawMessage) error {
		var value notifyPayload
		if err := json.Unmarshal(payload, &value); err != nil {
			return err
		}
		if value.UserID == "" || value.Channel == "" {
			return fmt.Errorf("userId and channel are required")
		}
		return nil
	})
}
