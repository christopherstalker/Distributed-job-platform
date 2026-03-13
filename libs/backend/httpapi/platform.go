package httpapi

import (
	"encoding/json"
	"net/http"

	"distributed-job-system/libs/backend/domain"

	"github.com/go-chi/chi/v5"
)

func (s *Server) handleDashboardSnapshot(w http.ResponseWriter, r *http.Request) {
	snapshot, err := s.manager.GetDashboardSnapshot(r.Context())
	if err != nil {
		s.writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, snapshot)
}

func (s *Server) handleJobInspection(w http.ResponseWriter, r *http.Request) {
	inspection, err := s.manager.GetJobInspection(r.Context(), chi.URLParam(r, "jobID"))
	if err != nil {
		s.writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, inspection)
}

func (s *Server) handleJobEvents(w http.ResponseWriter, r *http.Request) {
	events, err := s.manager.GetJobEvents(r.Context(), chi.URLParam(r, "jobID"), parseInt(r.URL.Query().Get("limit"), 100))
	if err != nil {
		s.writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, events)
}

func (s *Server) handleJobGraph(w http.ResponseWriter, r *http.Request) {
	graph, err := s.manager.GetDependencyGraph(r.Context(), chi.URLParam(r, "jobID"))
	if err != nil {
		s.writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, graph)
}

func (s *Server) handleListDeadLetters(w http.ResponseWriter, r *http.Request) {
	deadLetters, err := s.manager.ListDeadLetters(r.Context(), domain.DeadLetterFilter{
		Queue:     r.URL.Query().Get("queue"),
		ErrorType: r.URL.Query().Get("errorType"),
		Limit:     parseInt(r.URL.Query().Get("limit"), 100),
	})
	if err != nil {
		s.writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, deadLetters)
}

func (s *Server) handleReplayDeadLetters(w http.ResponseWriter, r *http.Request) {
	var req domain.DeadLetterReplayRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	jobs, err := s.manager.ReplayDeadLetters(r.Context(), req)
	if err != nil {
		s.writeError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, jobs)
}

func (s *Server) handleDeleteDeadLetters(w http.ResponseWriter, r *http.Request) {
	var req domain.DeadLetterDeleteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	if err := s.manager.DeleteDeadLetters(r.Context(), req); err != nil {
		s.writeError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]string{"status": "deleted"})
}

func (s *Server) handleListRateLimits(w http.ResponseWriter, r *http.Request) {
	policies, err := s.manager.ListRateLimitPolicies(r.Context())
	if err != nil {
		s.writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, policies)
}

func (s *Server) handleUpsertRateLimit(w http.ResponseWriter, r *http.Request) {
	var policy domain.RateLimitPolicy
	if err := json.NewDecoder(r.Body).Decode(&policy); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	saved, err := s.manager.UpsertRateLimitPolicy(r.Context(), policy)
	if err != nil {
		s.writeError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, saved)
}

func (s *Server) handleCreateDemoWorkflow(w http.ResponseWriter, r *http.Request) {
	var req struct {
		TenantID string `json:"tenantId"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	graph, err := s.manager.CreateDemoThumbnailWorkflow(r.Context(), req.TenantID)
	if err != nil {
		s.writeError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, graph)
}
