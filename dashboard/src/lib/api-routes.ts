/**
 * Frontend ↔ backend route contract.
 *
 * Backend public routes (see `libs/backend/httpapi/server.go`):
 * - REST is versioned under `/api/v1`
 * - Realtime transports are unversioned root paths: `/ws/events`, `/sse/events`
 *
 * Keep all route fragments centralized here so request construction does not drift.
 */

const API_V1_PREFIX = "";

export const API_ROUTES = {
  dashboardSnapshot: `${API_V1_PREFIX}/dashboard`,
  jobs: `${API_V1_PREFIX}/jobs`,
  workers: `${API_V1_PREFIX}/workers`,
  schedules: `${API_V1_PREFIX}/schedules`,
  deadLettersReplay: `${API_V1_PREFIX}/dlq/replay`,
  deadLettersDelete: `${API_V1_PREFIX}/dlq/delete`,
  workflowDemoThumbnail: `${API_V1_PREFIX}/workflows/demo/thumbnail`,
  jobRetry: (jobId: string) => `${API_V1_PREFIX}/jobs/${jobId}/retry`,
  jobCancel: (jobId: string) => `${API_V1_PREFIX}/jobs/${jobId}/cancel`,
  jobInspection: (jobId: string) => `${API_V1_PREFIX}/jobs/${jobId}/inspection`,
  jobsWithLimit: (limit: number) => `${API_V1_PREFIX}/jobs?limit=${limit}`,
} as const;

export const REALTIME_ROUTES = {
  websocket: "/ws/events",
  sse: "/sse/events",
} as const;
