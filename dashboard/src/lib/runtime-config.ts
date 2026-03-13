import { safeTrim } from "./safe";

function getEnvValue(key: string) {
  const env = import.meta.env as Record<string, unknown>;
  return safeTrim(env[key]);
}

function deriveWebSocketUrl(apiBaseUrl: string) {
  try {
    const parsed = new URL(apiBaseUrl);
    if (parsed.protocol === "http:") {
      parsed.protocol = "ws:";
      return parsed.toString().replace(/\/$/, "");
    }
    if (parsed.protocol === "https:") {
      parsed.protocol = "wss:";
      return parsed.toString().replace(/\/$/, "");
    }
    return "";
  } catch {
    return "";
  }
}

export function resolveDefaultApiBaseUrl() {
  return getEnvValue("VITE_API_URL");
}

export function resolveDefaultRealtimeBaseUrl(apiBaseUrl?: string) {
  const wsBaseUrl = getEnvValue("VITE_WS_URL");
  if (wsBaseUrl) {
    return wsBaseUrl;
  }

  const resolvedApiBaseUrl = safeTrim(apiBaseUrl) || resolveDefaultApiBaseUrl();
  return deriveWebSocketUrl(resolvedApiBaseUrl);
}

export function resolveDefaultAdminToken() {
  return safeTrim(getEnvValue("VITE_ADMIN_TOKEN") || getEnvValue("NEXT_PUBLIC_ADMIN_TOKEN")) || "dev-admin-token";
}
