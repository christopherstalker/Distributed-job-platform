import { normalizeBaseUrl, safeTrim } from "./safe";

function getEnvValue(key: string) {
  const env = import.meta.env as Record<string, unknown>;
  return safeTrim(env[key]);
}

function deriveWebSocketUrl(apiBaseUrl: string) {
  const normalizedApiBaseUrl = normalizeBaseUrl(apiBaseUrl);
  if (!normalizedApiBaseUrl) {
    return "";
  }

  try {
    const parsed = new URL(normalizedApiBaseUrl);
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

function resolveApiUrlFromEnv() {
  return normalizeBaseUrl(
    getEnvValue("VITE_API_URL") ||
      getEnvValue("NEXT_PUBLIC_API_URL") ||
      getEnvValue("VITE_API_BASE_URL"),
  ) || "";
}

function resolveWsUrlFromEnv() {
  return normalizeBaseUrl(
    getEnvValue("VITE_WS_URL") ||
      getEnvValue("NEXT_PUBLIC_WS_URL") ||
      getEnvValue("VITE_WS_BASE_URL"),
  ) || "";
}

export function resolveDefaultApiBaseUrl() {
  return resolveApiUrlFromEnv();
}

export function resolveDefaultRealtimeBaseUrl(apiBaseUrl?: string) {
  const explicitWsBaseUrl = resolveWsUrlFromEnv();
  if (explicitWsBaseUrl) {
    return deriveWebSocketUrl(explicitWsBaseUrl) || explicitWsBaseUrl;
  }

  const resolvedApiBaseUrl = normalizeBaseUrl(safeTrim(apiBaseUrl)) || resolveApiUrlFromEnv();
  return deriveWebSocketUrl(resolvedApiBaseUrl);
}

export function resolveDefaultAdminToken() {
  return safeTrim(getEnvValue("VITE_ADMIN_TOKEN") || getEnvValue("NEXT_PUBLIC_ADMIN_TOKEN")) || "dev-admin-token";
}
