import type { SystemEvent, TransportMode, TransportStatus } from "./models";
import { buildStreamUrl, buildSocketUrl, safeTrim } from "./safe";
import { REALTIME_ROUTES } from "./api-routes";

const WEBSOCKET_ATTEMPT_LIMIT = 3;
const SSE_ATTEMPT_LIMIT = 2;
const REALTIME_PROBE_DELAY_MS = 90_000;

type RealtimeMode = "websocket" | "sse";

type LiveTransportManagerOptions = {
  baseUrl: string;
  token: string;
  onEvent: (event: SystemEvent) => void;
  onMalformedMessage: () => void;
  onStatus: (status: TransportStatus) => void;
};

export class LiveTransportManager {
  private readonly options: LiveTransportManagerOptions;
  private mode: TransportMode = "polling";
  private state: TransportStatus["state"] = "idle";
  private attempt = 0;
  private lastMessageAt = "";
  private lastFailureAt = "";
  private lastError = "";
  private degradedReason = "";
  private nextRetryAt = "";
  private stopped = false;
  private retryTimer: number | null = null;
  private probeTimer: number | null = null;
  private socket: WebSocket | null = null;
  private eventSource: EventSource | null = null;

  constructor(options: LiveTransportManagerOptions) {
    this.options = options;
  }

  start() {
    this.stopped = false;
    this.clearTimers();
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.connect("websocket", 0, "");
    }, 0);
  }

  stop(nextState: TransportStatus["state"] = "paused") {
    this.stopped = true;
    this.clearTimers();
    this.closeCurrent();
    this.state = nextState;
    this.attempt = 0;
    this.nextRetryAt = "";
    this.emitStatus();
  }

  retryNow() {
    if (this.stopped) {
      return;
    }
    this.clearTimers();
    this.degradedReason = "";
    this.lastError = "";
    this.nextRetryAt = "";
    this.connect("websocket", 0, "Manual reconnect requested.");
  }

  private connect(mode: RealtimeMode, attempt: number, reason: string) {
    if (this.stopped) {
      return;
    }

    this.clearTimers();
    this.closeCurrent();
    this.mode = mode;
    this.state = "connecting";
    this.attempt = attempt;
    if (reason) {
      this.degradedReason = reason;
    }
    this.emitStatus();

    if (mode === "websocket") {
      this.openWebSocket(attempt);
      return;
    }
    this.openEventSource(attempt);
  }

  private openWebSocket(attempt: number) {
    const socketUrl = buildSocketUrl(this.options.baseUrl, this.options.token);
    if (!socketUrl) {
      this.enterPolling("Invalid WebSocket URL.");
      return;
    }

    let opened = false;
    let socket: WebSocket;
    try {
      socket = new WebSocket(socketUrl);
    } catch {
      this.handleRealtimeFailure("websocket", attempt, "WebSocket initialization failed.");
      return;
    }

    this.socket = socket;

    socket.onopen = () => {
      if (this.socket !== socket || this.stopped) {
        return;
      }
      opened = true;
      this.mode = "websocket";
      this.state = "live";
      this.attempt = 0;
      this.degradedReason = "";
      this.lastError = "";
      this.nextRetryAt = "";
      this.emitStatus();
    };

    socket.onmessage = (message) => {
      if (this.socket !== socket || this.stopped) {
        return;
      }
      const event = parseTransportEvent(message.data);
      if (!event) {
        this.options.onMalformedMessage();
        return;
      }
      this.lastMessageAt = new Date().toISOString();
      this.options.onEvent(event);
      this.emitStatus();
    };

    socket.onerror = () => {
      if (this.socket !== socket || this.stopped) {
        return;
      }
      this.lastError = "WebSocket transport error.";
      this.emitStatus();
    };

    socket.onclose = (event) => {
      if (this.socket !== socket || this.stopped) {
        return;
      }
      this.socket = null;
      const reason = safeTrim(event.reason) || `WebSocket closed (${event.code || "unknown"}).`;
      this.handleRealtimeFailure("websocket", attempt, opened ? reason : `WebSocket upgrade failed: ${reason}`);
    };
  }

  private openEventSource(attempt: number) {
    if (typeof EventSource === "undefined") {
      this.enterPolling("Server-Sent Events are not supported in this browser.");
      return;
    }

    const streamUrl = buildStreamUrl(this.options.baseUrl, REALTIME_ROUTES.sse, {
      token: this.options.token,
    });
    if (!streamUrl) {
      this.enterPolling("Invalid SSE URL.");
      return;
    }

    const source = new EventSource(streamUrl);
    this.eventSource = source;

    source.onopen = () => {
      if (this.eventSource !== source || this.stopped) {
        return;
      }
      this.mode = "sse";
      this.state = "live";
      this.attempt = 0;
      this.degradedReason = "";
      this.lastError = "";
      this.nextRetryAt = "";
      this.emitStatus();
      this.scheduleProbe(() => {
        this.connect("websocket", 0, "Probing WebSocket recovery after SSE fallback.");
      }, REALTIME_PROBE_DELAY_MS);
    };

    source.onmessage = (message) => {
      if (this.eventSource !== source || this.stopped) {
        return;
      }
      const event = parseTransportEvent(message.data);
      if (!event) {
        this.options.onMalformedMessage();
        return;
      }
      this.lastMessageAt = new Date().toISOString();
      this.options.onEvent(event);
      this.emitStatus();
    };

    source.onerror = () => {
      if (this.eventSource !== source || this.stopped) {
        return;
      }
      this.eventSource.close();
      this.eventSource = null;
      this.handleRealtimeFailure("sse", attempt, "SSE stream disconnected.");
    };
  }

  private handleRealtimeFailure(mode: RealtimeMode, attempt: number, reason: string) {
    if (this.stopped) {
      return;
    }

    this.lastFailureAt = new Date().toISOString();
    this.lastError = reason;

    if (mode === "websocket" && attempt + 1 < WEBSOCKET_ATTEMPT_LIMIT) {
      this.scheduleRetry("websocket", attempt + 1, reason);
      return;
    }

    if (mode === "websocket") {
      if (typeof EventSource !== "undefined" && buildStreamUrl(this.options.baseUrl, REALTIME_ROUTES.sse, { token: this.options.token })) {
        this.connect("sse", 0, "WebSocket upgrades failed. Falling back to SSE.");
        return;
      }
      this.enterPolling("WebSocket upgrades failed and SSE is unavailable.");
      return;
    }

    if (attempt + 1 < SSE_ATTEMPT_LIMIT) {
      this.scheduleRetry("sse", attempt + 1, reason);
      return;
    }

    this.enterPolling("Realtime stream unavailable. Using polling until a later probe succeeds.");
  }

  private scheduleRetry(mode: RealtimeMode, attempt: number, reason: string) {
    this.lastFailureAt = new Date().toISOString();
    const delayMs = getBackoffDelay(attempt, mode === "websocket" ? 900 : 1_500, mode === "websocket" ? 12_000 : 20_000);
    this.nextRetryAt = new Date(Date.now() + delayMs).toISOString();
    this.degradedReason = reason;
    this.mode = mode;
    this.state = "connecting";
    this.attempt = attempt;
    this.emitStatus();

    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.connect(mode, attempt, reason);
    }, delayMs);
  }

  private enterPolling(reason: string) {
    this.clearTimers();
    this.closeCurrent();
    this.mode = "polling";
    this.state = "polling";
    this.attempt = 0;
    this.degradedReason = reason;
    this.lastFailureAt = new Date().toISOString();
    this.lastError = reason;
    this.emitStatus();

    this.scheduleProbe(() => {
      this.connect("websocket", 0, "Retrying realtime transport after polling fallback.");
    }, REALTIME_PROBE_DELAY_MS);
  }

  private scheduleProbe(task: () => void, delayMs: number) {
    if (this.stopped) {
      return;
    }
    this.nextRetryAt = new Date(Date.now() + delayMs).toISOString();
    this.emitStatus();
    this.probeTimer = window.setTimeout(() => {
      this.probeTimer = null;
      this.nextRetryAt = "";
      task();
    }, delayMs);
  }

  private clearTimers() {
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.probeTimer !== null) {
      window.clearTimeout(this.probeTimer);
      this.probeTimer = null;
    }
  }

  private closeCurrent() {
    if (this.socket) {
      const socket = this.socket;
      this.socket.onopen = null;
      this.socket.onmessage = null;
      this.socket.onerror = null;
      this.socket.onclose = null;
      if (socket.readyState === WebSocket.CONNECTING) {
        socket.addEventListener(
          "open",
          () => {
            socket.close();
          },
          { once: true },
        );
      } else {
        socket.close();
      }
      this.socket = null;
    }
    if (this.eventSource) {
      this.eventSource.onopen = null;
      this.eventSource.onmessage = null;
      this.eventSource.onerror = null;
      this.eventSource.close();
      this.eventSource = null;
    }
  }

  private emitStatus() {
    this.options.onStatus({
      mode: this.mode,
      state: this.state,
      attempt: this.attempt,
      lastMessageAt: this.lastMessageAt,
      lastFailureAt: this.lastFailureAt,
      lastError: this.lastError,
      degradedReason: this.degradedReason,
      nextRetryAt: this.nextRetryAt,
    });
  }
}

export function getBackoffDelay(attempt: number, baseMs: number, capMs: number) {
  const baseDelay = Math.min(baseMs * 2 ** Math.max(attempt - 1, 0), capMs);
  const jitter = Math.round(baseDelay * 0.3 * Math.random());
  return Math.min(baseDelay + jitter, capMs);
}

export function formatTransportMode(mode: TransportMode) {
  switch (mode) {
    case "websocket":
      return "Live (WebSocket)";
    case "sse":
      return "Live (SSE)";
    case "polling":
      return "Polling";
    case "degraded":
      return "Degraded";
    case "offline":
      return "Offline";
    case "demo":
      return "Demo";
    default:
      return "Polling";
  }
}

function parseTransportEvent(payload: unknown) {
  try {
    const raw =
      typeof payload === "string"
        ? payload
        : payload instanceof ArrayBuffer
          ? new TextDecoder().decode(payload)
          : String(payload);
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || !("kind" in parsed) || typeof (parsed as { kind: unknown }).kind !== "string") {
      return null;
    }
    return parsed as SystemEvent;
  } catch {
    return null;
  }
}
