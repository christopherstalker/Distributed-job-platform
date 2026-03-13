package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"time"

	"distributed-job-system/libs/backend/domain"
	"distributed-job-system/libs/backend/service"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	chicors "github.com/go-chi/cors"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/redis/go-redis/v9"
)

type Subscriber interface {
	Subscribe(context.Context) *redis.PubSub
}

type Server struct {
	manager         *service.Manager
	log             *slog.Logger
	adminToken      string
	dashboardOrigin string
	hub             *Hub
	registry        *prometheus.Registry
}

func NewServer(manager *service.Manager, subscriber Subscriber, log *slog.Logger, registry *prometheus.Registry, adminToken, dashboardOrigin string) *Server {
	server := &Server{
		manager:         manager,
		log:             log,
		adminToken:      adminToken,
		dashboardOrigin: dashboardOrigin,
		hub:             NewHub(log, dashboardOrigin),
		registry:        registry,
	}
	if subscriber != nil {
		go server.hub.Run(context.Background(), subscriber.Subscribe(context.Background()))
	}
	return server
}

func (s *Server) Handler() http.Handler {
	allowedOrigins := corsOrigins(s.dashboardOrigin)
	router := chi.NewRouter()
	router.Use(middleware.RequestID)
	router.Use(middleware.RealIP)
	router.Use(middleware.Recoverer)
	router.Use(chicors.Handler(chicors.Options{
		AllowedOrigins:   allowedOrigins,
		AllowedMethods:   []string{"GET", "POST", "OPTIONS"},
		AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type", "X-Admin-Token"},
		AllowCredentials: true,
		MaxAge:           300,
	}))

	router.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	router.Get("/readyz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
	})
	router.Handle("/metrics", promhttp.HandlerFor(s.registry, promhttp.HandlerOpts{}))

	router.Group(func(r chi.Router) {
		r.Use(s.authMiddleware)
		r.Get("/ws/events", s.handleWebSocket)
		r.Get("/sse/events", s.handleSSE)
	})

	router.Group(func(r chi.Router) {
		r.Use(middleware.Timeout(30 * time.Second))
		r.Use(s.authMiddleware)
		r.Route("/api/v1", func(api chi.Router) {
			api.Get("/overview", s.handleOverview)
			api.Get("/dashboard", s.handleDashboardSnapshot)
			api.Get("/jobs", s.handleListJobs)
			api.Get("/jobs/{jobID}", s.handleGetJob)
			api.Get("/jobs/{jobID}/inspection", s.handleJobInspection)
			api.Get("/jobs/{jobID}/events", s.handleJobEvents)
			api.Get("/jobs/{jobID}/graph", s.handleJobGraph)
			api.Post("/jobs", s.handleCreateJob)
			api.Post("/jobs/batch", s.handleCreateBatch)
			api.Post("/jobs/{jobID}/retry", s.handleRetryJob)
			api.Post("/jobs/{jobID}/cancel", s.handleCancelJob)
			api.Get("/dlq", s.handleListDeadLetters)
			api.Post("/dlq/replay", s.handleReplayDeadLetters)
			api.Post("/dlq/delete", s.handleDeleteDeadLetters)
			api.Get("/rate-limits", s.handleListRateLimits)
			api.Post("/rate-limits", s.handleUpsertRateLimit)
			api.Post("/workflows/demo/thumbnail", s.handleCreateDemoWorkflow)
			api.Get("/workers", s.handleListWorkers)
			api.Get("/schedules", s.handleListSchedules)
			api.Post("/schedules", s.handleUpsertSchedule)
		})
	})

	router.NotFound(s.handleNotFound())

	return router
}

func (s *Server) authMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.adminToken == "" {
			next.ServeHTTP(w, r)
			return
		}
		token := r.Header.Get("X-Admin-Token")
		if token == "" {
			token = bearerToken(r.Header.Get("Authorization"))
		}
		if token == "" {
			token = r.URL.Query().Get("token")
		}
		if token != s.adminToken {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) handleOverview(w http.ResponseWriter, r *http.Request) {
	overview, err := s.manager.GetOverview(r.Context())
	if err != nil {
		s.writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, overview)
}

func (s *Server) handleListJobs(w http.ResponseWriter, r *http.Request) {
	filter := domain.ListJobsFilter{
		State:      domain.JobState(r.URL.Query().Get("state")),
		Queue:      r.URL.Query().Get("queue"),
		Worker:     r.URL.Query().Get("worker"),
		TenantID:   r.URL.Query().Get("tenantId"),
		WorkflowID: r.URL.Query().Get("workflowId"),
		Limit:      parseInt(r.URL.Query().Get("limit"), 100),
	}
	jobs, err := s.manager.ListJobs(r.Context(), filter)
	if err != nil {
		s.writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, jobs)
}

func (s *Server) handleGetJob(w http.ResponseWriter, r *http.Request) {
	job, err := s.manager.GetJob(r.Context(), chi.URLParam(r, "jobID"))
	if err != nil {
		s.writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, job)
}

func (s *Server) handleCreateJob(w http.ResponseWriter, r *http.Request) {
	var req domain.JobRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	job, err := s.manager.EnqueueJob(r.Context(), req)
	if err != nil {
		s.writeError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, job)
}

func (s *Server) handleCreateBatch(w http.ResponseWriter, r *http.Request) {
	var req domain.BatchEnqueueRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	jobs, err := s.manager.EnqueueBatch(r.Context(), req.Jobs)
	if err != nil {
		s.writeError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, jobs)
}

func (s *Server) handleRetryJob(w http.ResponseWriter, r *http.Request) {
	job, err := s.manager.RetryJob(r.Context(), chi.URLParam(r, "jobID"))
	if err != nil {
		s.writeError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, job)
}

func (s *Server) handleCancelJob(w http.ResponseWriter, r *http.Request) {
	job, err := s.manager.CancelJob(r.Context(), chi.URLParam(r, "jobID"))
	if err != nil {
		s.writeError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, job)
}

func (s *Server) handleListWorkers(w http.ResponseWriter, r *http.Request) {
	workers, err := s.manager.ListWorkers(r.Context())
	if err != nil {
		s.writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, workers)
}

func (s *Server) handleListSchedules(w http.ResponseWriter, r *http.Request) {
	schedules, err := s.manager.ListSchedules(r.Context())
	if err != nil {
		s.writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, schedules)
}

func (s *Server) handleUpsertSchedule(w http.ResponseWriter, r *http.Request) {
	var req domain.ScheduleRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	schedule, err := s.manager.UpsertSchedule(r.Context(), req)
	if err != nil {
		s.writeError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, schedule)
}

func (s *Server) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	if err := s.hub.Register(w, r); err != nil {
		s.log.Warn("websocket upgrade failed", "error", err)
	}
}

func (s *Server) handleSSE(w http.ResponseWriter, r *http.Request) {
	if err := s.hub.RegisterSSE(w, r); err != nil {
		s.log.Warn("sse stream failed", "error", err)
	}
}

func (s *Server) handleNotFound() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if target, ok := s.dashboardRedirectTarget(r); ok {
			http.Redirect(w, r, target, http.StatusTemporaryRedirect)
			return
		}
		http.NotFound(w, r)
	}
}

func (s *Server) writeError(w http.ResponseWriter, err error) {
	status := http.StatusInternalServerError
	if errors.Is(err, redis.Nil) {
		status = http.StatusNotFound
	}
	writeJSON(w, status, map[string]string{"error": err.Error()})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func bearerToken(header string) string {
	const prefix = "Bearer "
	if len(header) >= len(prefix) && header[:len(prefix)] == prefix {
		return header[len(prefix):]
	}
	return ""
}

func parseInt(value string, fallback int) int {
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func corsOrigins(configuredOrigin string) []string {
	origins := []string{
		"http://localhost:3000",
		"http://127.0.0.1:3000",
	}
	if configuredOrigin != "" {
		origins = append(origins, configuredOrigin)
		if parsed, err := url.Parse(configuredOrigin); err == nil {
			switch parsed.Hostname() {
			case "localhost":
				origins = append(origins, "http://127.0.0.1:3000")
			case "127.0.0.1":
				origins = append(origins, "http://localhost:3000")
			}
		}
	}
	seen := map[string]struct{}{}
	out := make([]string, 0, len(origins))
	for _, origin := range origins {
		if origin == "" {
			continue
		}
		if _, ok := seen[origin]; ok {
			continue
		}
		seen[origin] = struct{}{}
		out = append(out, origin)
	}
	return out
}

func (s *Server) dashboardRedirectTarget(r *http.Request) (string, bool) {
	if s.dashboardOrigin == "" {
		return "", false
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		return "", false
	}
	if !shouldRedirectToDashboard(r) {
		return "", false
	}

	parsed, err := url.Parse(s.dashboardOrigin)
	if err != nil {
		return "", false
	}

	target := *parsed
	target.Path = joinDashboardPath(parsed.Path, r.URL.Path)
	target.RawQuery = r.URL.RawQuery
	return target.String(), true
}

func shouldRedirectToDashboard(r *http.Request) bool {
	switch {
	case r.URL.Path == "/", r.URL.Path == "/index.html", r.URL.Path == "/favicon.ico":
		return true
	case strings.HasPrefix(r.URL.Path, "/assets/"):
		return true
	case strings.HasPrefix(r.URL.Path, "/api/"), strings.HasPrefix(r.URL.Path, "/ws/"), strings.HasPrefix(r.URL.Path, "/sse/"), r.URL.Path == "/metrics", r.URL.Path == "/healthz", r.URL.Path == "/readyz":
		return false
	default:
		return strings.Contains(r.Header.Get("Accept"), "text/html")
	}
}

func joinDashboardPath(basePath, requestPath string) string {
	if requestPath == "/" || requestPath == "" {
		if basePath == "" {
			return "/"
		}
		return basePath
	}
	if basePath == "" || basePath == "/" {
		return requestPath
	}
	return path.Join(basePath, requestPath)
}
