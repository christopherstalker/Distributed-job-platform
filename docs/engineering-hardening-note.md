# Engineering Hardening Note

## App-Caused Errors Vs Extension Noise

App-caused issues confirmed during the hardening pass:

- the dashboard polling effect could refetch continuously because successful refresh state re-triggered the polling effect immediately
- SSE lived behind the same 30-second timeout middleware as REST endpoints, which made fallback transport unstable
- live-mode write actions could mutate local demo state when the backend was unavailable, creating fake success paths
- the frontend error-noise filter was broad enough to suppress genuine app crashes that mentioned `null` or `.includes`

Extension-caused noise that is still treated as browser noise rather than app failure:

- `Unchecked runtime.lastError: Could not establish connection. Receiving end does not exist.`
- explicit `chrome-extension://`, `moz-extension://`, `safari-web-extension://`, Bitwarden, LastPass, or 1Password injection failures
- known autofill/bootstrap extension signatures such as `bootstrap-autofill`

## Backend Gaps

The backend still does not expose control-plane endpoints for:

- queue pause, resume, or drain
- worker cordon / maintenance mode
- live priority mutation

Those controls remain available only in demo mode. In live mode they are intentionally disabled with an explanation instead of faking local success.

## Architectural Vs Cosmetic Changes

Architectural fixes:

- moved long-lived websocket and SSE routes out of the generic 30-second timeout middleware
- changed live-mode initialization to start from an honest empty live state instead of demo data
- removed fake live-mode action fallbacks so writes always target the backend when live mode is enabled
- stabilized polling so it schedules from timers and refs instead of success timestamps
- tightened request timeout/error classification and narrowed extension-noise filtering
- added frontend regression tests for polling stability, empty-live fallback, toast dedupe, and extension-noise classification

Cosmetic/performance tuning:

- reduced some backdrop blur intensity to lower rendering cost during live updates
- added explicit capability notes beside demo-only controls so the UI communicates limitations quietly and clearly
