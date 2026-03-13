import { buildApiUrl, safeTrim } from "./safe";

export type RequestErrorKind =
  | "aborted"
  | "auth"
  | "config"
  | "empty"
  | "network"
  | "parse"
  | "server"
  | "timeout";

export class RequestError extends Error {
  kind: RequestErrorKind;
  status: number;
  retriable: boolean;

  constructor(message: string, options: { kind: RequestErrorKind; status?: number; retriable?: boolean }) {
    super(message);
    this.kind = options.kind;
    this.status = options.status ?? 0;
    this.retriable = options.retriable ?? !["auth", "config", "parse"].includes(options.kind);
  }
}

type JsonParser<T> = (value: unknown) => T;

type RequestJsonOptions<T> = {
  baseUrl: string | null;
  path: string;
  token?: string;
  init?: RequestInit;
  timeoutMs?: number;
  parser?: JsonParser<T>;
  allowEmpty?: boolean;
};

export async function requestJson<T>({
  baseUrl,
  path,
  token,
  init,
  timeoutMs = 10_000,
  parser,
  allowEmpty = false,
}: RequestJsonOptions<T>): Promise<T> {
  const url = buildApiUrl(baseUrl, path);
  if (!url) {
    throw new RequestError("Enter a valid API base URL to resume live data.", {
      kind: "config",
      retriable: false,
    });
  }

  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const trimmedToken = safeTrim(token);
  if (trimmedToken) {
    headers.set("Authorization", `Bearer ${trimmedToken}`);
  }

  const controller = new AbortController();
  const abortBinding = bindAbortSignals(controller, init?.signal, timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers,
      signal: controller.signal,
    });
  } catch (error) {
    abortBinding.release();
    throw classifyFetchError(error, abortBinding);
  }

  let bodyText = "";
  try {
    bodyText = await response.text();
  } catch (error) {
    abortBinding.release();
    throw classifyFetchError(error, abortBinding);
  }
  abortBinding.release();

  const body = parseBody(bodyText);
  if (!response.ok) {
    throw buildResponseError(response, body, bodyText);
  }

  if (!bodyText) {
    if (allowEmpty) {
      return null as T;
    }
    throw new RequestError(`The ${path} response was empty.`, {
      kind: "empty",
      status: response.status,
    });
  }

  if (!parser) {
    return body as T;
  }

  try {
    return parser(body);
  } catch (error) {
    throw new RequestError(
      error instanceof Error ? error.message : `The ${path} response was malformed.`,
      {
        kind: "parse",
        status: response.status,
        retriable: false,
      },
    );
  }
}

function bindAbortSignals(controller: AbortController, signal: AbortSignal | null | undefined, timeoutMs: number) {
  let abortReason: unknown = null;
  let timedOut = false;

  const abort = (reason: unknown) => {
    if (controller.signal.aborted) {
      return;
    }
    abortReason = reason;
    timedOut = reason instanceof DOMException && reason.name === "TimeoutError";
    controller.abort(reason);
  };

  const timeoutId = window.setTimeout(() => {
    abort(new DOMException("Request timed out", "TimeoutError"));
  }, timeoutMs);

  const onAbort = () => {
    abort(signal?.reason);
  };

  if (signal) {
    if (signal.aborted) {
      abort(signal.reason);
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  return {
    didTimeout() {
      return timedOut;
    },
    getAbortReason() {
      return abortReason ?? controller.signal.reason;
    },
    release() {
      window.clearTimeout(timeoutId);
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
    },
  };
}

function parseBody(bodyText: string): unknown {
  const trimmed = bodyText.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return bodyText;
  }
}

function buildResponseError(response: Response, body: unknown, bodyText: string) {
  const message =
    body && typeof body === "object" && "error" in body
      ? safeTrim((body as { error?: unknown }).error)
      : safeTrim(bodyText);
  if (response.status === 401 || response.status === 403) {
    return new RequestError(message || "Authentication failed for the dashboard API.", {
      kind: "auth",
      status: response.status,
      retriable: false,
    });
  }
  return new RequestError(message || `Request failed with ${response.status}.`, {
    kind: "server",
    status: response.status,
  });
}

function classifyFetchError(
  error: unknown,
  binding?: { didTimeout: () => boolean; getAbortReason: () => unknown },
) {
  if (error instanceof RequestError) {
    return error;
  }
  const abortReason = binding?.getAbortReason();
  if (binding?.didTimeout() || (abortReason instanceof DOMException && abortReason.name === "TimeoutError")) {
    return new RequestError("Request timed out before the API responded.", {
      kind: "timeout",
    });
  }
  if (error instanceof DOMException) {
    if (error.name === "AbortError") {
      return new RequestError("Request was cancelled.", { kind: "aborted" });
    }
    if (error.name === "TimeoutError") {
      return new RequestError("Request timed out before the API responded.", {
        kind: "timeout",
      });
    }
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new RequestError("Request was cancelled.", { kind: "aborted" });
  }
  return new RequestError("Network request failed before a response was received.", {
    kind: "network",
  });
}
