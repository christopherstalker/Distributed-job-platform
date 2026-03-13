package integration

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"distributed-job-system/libs/backend/domain"
	"distributed-job-system/libs/backend/httpapi"
	"distributed-job-system/libs/backend/service"

	"github.com/prometheus/client_golang/prometheus"
)

func TestAPIEnqueueAndCancelLifecycle(t *testing.T) {
	repo := &fakeRepo{
		jobs:               make(map[string]domain.Job),
		events:             make(map[string][]domain.JobEvent),
		attempts:           make(map[string][]domain.JobAttempt),
		dependencies:       make(map[string][]domain.JobDependency),
		deadLetters:        make(map[string]domain.DeadLetter),
		idempotencyRecords: make(map[string]domain.IdempotencyRecord),
	}
	broker := &fakeBroker{
		jobs: make(map[string]domain.Job),
	}
	manager := service.NewManager(repo, broker, nil, nil, slog.Default())
	server := httpapi.NewServer(manager, nil, slog.Default(), prometheus.NewRegistry(), "dev-token", "http://localhost:3000")
	ts := httptest.NewServer(server.Handler())
	defer ts.Close()

	body := bytes.NewBufferString(`{"type":"email.send","queue":"critical","priority":9,"maxAttempts":3,"payload":{"recipient":"ops@example.com"}}`)
	request, err := http.NewRequest(http.MethodPost, ts.URL+"/api/v1/jobs", body)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer dev-token")
	request.Header.Set("Content-Type", "application/json")

	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusAccepted {
		t.Fatalf("expected 202, got %d", response.StatusCode)
	}

	var created domain.EnqueueResult
	if err := json.NewDecoder(response.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}
	if created.Job.Queue != "critical" {
		t.Fatalf("expected critical queue, got %s", created.Job.Queue)
	}

	cancelRequest, err := http.NewRequest(http.MethodPost, ts.URL+"/api/v1/jobs/"+created.Job.ID+"/cancel", nil)
	if err != nil {
		t.Fatal(err)
	}
	cancelRequest.Header.Set("Authorization", "Bearer dev-token")

	cancelResponse, err := http.DefaultClient.Do(cancelRequest)
	if err != nil {
		t.Fatal(err)
	}
	defer cancelResponse.Body.Close()
	if cancelResponse.StatusCode != http.StatusAccepted {
		t.Fatalf("expected 202 on cancel, got %d", cancelResponse.StatusCode)
	}

	getRequest, err := http.NewRequest(http.MethodGet, ts.URL+"/api/v1/jobs/"+created.Job.ID, nil)
	if err != nil {
		t.Fatal(err)
	}
	getRequest.Header.Set("Authorization", "Bearer dev-token")
	getResponse, err := http.DefaultClient.Do(getRequest)
	if err != nil {
		t.Fatal(err)
	}
	defer getResponse.Body.Close()
	if getResponse.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(getResponse.Body)
		t.Fatalf("expected 200, got %d: %s", getResponse.StatusCode, string(bodyBytes))
	}
	var fetched domain.Job
	if err := json.NewDecoder(getResponse.Body).Decode(&fetched); err != nil {
		t.Fatal(err)
	}
	if fetched.State != domain.JobStateCanceled {
		t.Fatalf("expected canceled state, got %s", fetched.State)
	}
}

type fakeRepo struct {
	mu                 sync.Mutex
	jobs               map[string]domain.Job
	workers            []domain.WorkerStatus
	schedules          []domain.Schedule
	events             map[string][]domain.JobEvent
	attempts           map[string][]domain.JobAttempt
	dependencies       map[string][]domain.JobDependency
	deadLetters        map[string]domain.DeadLetter
	idempotencyRecords map[string]domain.IdempotencyRecord
	rateLimitPolicies  []domain.RateLimitPolicy
}

type fakeBroker struct {
	mu   sync.Mutex
	jobs map[string]domain.Job
}
