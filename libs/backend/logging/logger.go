package logging

import (
	"log/slog"
	"os"
	"strings"
)

func New(level string) *slog.Logger {
	options := &slog.HandlerOptions{Level: slog.LevelInfo}
	switch strings.ToLower(level) {
	case "debug":
		options.Level = slog.LevelDebug
	case "warn":
		options.Level = slog.LevelWarn
	case "error":
		options.Level = slog.LevelError
	}
	handler := slog.NewJSONHandler(os.Stdout, options)
	return slog.New(handler)
}
