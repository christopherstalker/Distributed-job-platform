import { normalizeBaseUrl, safeTrim } from "./safe";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function getEnvValue(key: string) {
  const env = import.meta.env as Record<string, unknown>;
  return safeTrim(env[key]);
}

export function resolveDefaultApiBaseUrl() {
  const explicit = normalizeBaseUrl(getEnvValue("VITE_API_BASE_URL") || getEnvValue("NEXT_PUBLIC_API_URL"));
  if (explicit) {
    return explicit;
  }

  if (typeof window === "undefined") {
    return "";
  }

  const host = safeTrim(window.location.hostname).toLowerCase();
  if (LOCAL_HOSTS.has(host)) {
    return "http://localhost:8080";
  }

  return normalizeBaseUrl(window.location.origin) ?? "";
}

export function resolveDefaultRealtimeBaseUrl(apiBaseUrl: string) {
  const explicit = normalizeBaseUrl(getEnvValue("VITE_WS_BASE_URL") || getEnvValue("NEXT_PUBLIC_WS_URL"));
  if (explicit) {
    return explicit;
  }
  return normalizeBaseUrl(apiBaseUrl) ?? "";
}

export function resolveDefaultAdminToken() {
  return safeTrim(getEnvValue("VITE_ADMIN_TOKEN") || getEnvValue("NEXT_PUBLIC_ADMIN_TOKEN")) || "dev-admin-token";
}
