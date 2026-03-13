package scheduler

import (
	"testing"
	"time"

	"distributed-job-system/libs/backend/domain"
)

func TestNextRunHonorsTimezone(t *testing.T) {
	now := time.Date(2026, time.March, 12, 8, 30, 0, 0, time.UTC)
	schedule := domain.Schedule{
		CronExpression: "0 12 * * *",
		Timezone:       "Europe/Kiev",
	}

	got, err := nextRun(schedule, now)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	want := time.Date(2026, time.March, 12, 10, 0, 0, 0, time.UTC)
	if !got.Equal(want) {
		t.Fatalf("expected %s, got %s", want, got)
	}
}
