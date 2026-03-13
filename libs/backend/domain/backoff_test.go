package domain

import (
	"testing"
	"time"
)

func TestComputeBackoffCapsAtMaximum(t *testing.T) {
	base := 5 * time.Second
	max := 40 * time.Second

	if got := ComputeBackoff(1, base, max); got != 5*time.Second {
		t.Fatalf("expected 5s, got %s", got)
	}
	if got := ComputeBackoff(2, base, max); got != 10*time.Second {
		t.Fatalf("expected 10s, got %s", got)
	}
	if got := ComputeBackoff(10, base, max); got != max {
		t.Fatalf("expected capped value %s, got %s", max, got)
	}
}
