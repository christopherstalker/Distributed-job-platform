# Vercel API 404 Investigation Report

## Findings

### 1) Do `/api/v1/*` endpoints exist in this codebase?
Yes. The Go HTTP API defines these endpoints under `/api/v1`:

- `GET /api/v1/dashboard`
- `GET /api/v1/jobs`
- `GET /api/v1/schedules`
- `GET /api/v1/workers`

These routes are implemented in `libs/backend/httpapi/server.go`.

### 2) Is that backend actually deployed by Vercel in this repository?
No, not from the current `vercel.json` setup.

Current Vercel config is a static Vite deployment:

- `framework: "vite"`
- `buildCommand: "npm run build"`
- `outputDirectory: "dist"`

There are no Vercel Functions configured and no rewrite/proxy rules for `/api/*`, so Vercel serves only the frontend build artifacts.

Also, the backend entrypoint (`api/main.go`) is a long-running Go server that expects persistent Redis/PostgreSQL connectivity and process lifetime semantics; this is not aligned with Vercel's static frontend deployment model and would require a dedicated backend runtime (Railway/Render/Fly/Kubernetes/VM) or a serverless redesign.

### 3) Is `vercel.json` rewriting `/api/v1/*` to a backend?
No. There are no `rewrites` or `redirects` in `vercel.json`.

### 4) Frontend base URL behavior and mismatch
The frontend route constants correctly target `/api/v1/...` paths.

However, API base URL resolution is environment-dependent:

- It uses `NEXT_PUBLIC_API_URL`, `VITE_API_URL`, or `VITE_API_BASE_URL`.
- If not set in production, the resolved base URL is empty and requests become relative to the frontend origin (the Vercel app domain).
- Since Vercel is currently only serving static frontend files and no `/api/v1/*` handlers, relative calls return `404 Not Found`.

## Recommended Fix Paths

Choose one of the two production patterns below.

### Option A (recommended): Deploy backend separately, point frontend to it
1. Deploy Go API (`./api`) on a backend-friendly platform (Railway/Render/Fly.io/etc.).
2. Set Vercel env var:
   - `NEXT_PUBLIC_API_URL=https://<your-api-domain>`
3. (Optional) Set websocket URL if realtime is separate:
   - `NEXT_PUBLIC_WS_URL=wss://<your-api-domain>`
4. Ensure CORS in backend allows the Vercel frontend origin (`DASHBOARD_ORIGIN` / config equivalent).

### Option B: Keep same-origin frontend URL using Vercel rewrites
Add rewrites so browser requests to `/api/*` are proxied to your external backend:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "framework": "vite",
  "installCommand": "npm ci",
  "buildCommand": "npm run build",
  "outputDirectory": "dist",
  "rewrites": [
    {
      "source": "/api/:match*",
      "destination": "https://<your-api-domain>/api/:match*"
    },
    {
      "source": "/ws/:match*",
      "destination": "https://<your-api-domain>/ws/:match*"
    },
    {
      "source": "/sse/:match*",
      "destination": "https://<your-api-domain>/sse/:match*"
    }
  ]
}
```

> Note: replace `<your-api-domain>` with your real backend hostname.

## Validation checklist (production)

1. Confirm backend health endpoint responds:
   - `curl -i https://<api-domain>/healthz`
2. Confirm protected API endpoint responds with auth:
   - `curl -i https://<api-domain>/api/v1/dashboard -H "Authorization: Bearer <token>"`
3. In Vercel project settings, verify env vars:
   - `NEXT_PUBLIC_API_URL`
   - `NEXT_PUBLIC_WS_URL` (if needed)
   - `NEXT_PUBLIC_ADMIN_TOKEN` (if used by UI defaults)
4. Confirm frontend network requests target expected hostname (browser devtools).
5. If using rewrites, verify deployed `vercel.json` contains rewrite rules.
6. Confirm backend CORS allows the Vercel frontend domain.
7. Test the four failing endpoints from browser and curl:
   - `/api/v1/dashboard`
   - `/api/v1/jobs`
   - `/api/v1/schedules`
   - `/api/v1/workers`
8. Confirm websocket fallback paths if using live updates:
   - `/ws/events`, `/sse/events`

## Final summary

- Your backend routes do exist in Go, but Vercel is currently deploying only a static Vite frontend.
- The frontend is therefore calling `/api/v1/*` on the Vercel domain where no backend handlers are present, producing 404s.
- Fix by either setting `NEXT_PUBLIC_API_URL` to a separately deployed backend, or by adding explicit Vercel rewrites that proxy `/api`, `/ws`, and `/sse` to that backend.
