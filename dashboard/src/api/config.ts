import { normalizeBaseUrl, safeTrim } from "../lib/safe";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function getEnvValue(key: string) {
  const env = import.meta.env as Record<string, unknown>;
  return safeTrim(env[key]);
}

function resolveExplicitApiBaseUrl() {
  return normalizeBaseUrl(getEnvValue("NEXT_PUBLIC_API_URL") || getEnvValue("VITE_API_BASE_URL"));
}

function resolveExplicitWsBaseUrl() {
  return normalizeBaseUrl(getEnvValue("NEXT_PUBLIC_WS_URL") || getEnvValue("VITE_WS_BASE_URL"));
}

export const API_BASE_URL = (() => {
  const explicit = resolveExplicitApiBaseUrl();
  if (explicit) {
    return explicit;
  }

  if (!import.meta.env.DEV || typeof window === "undefined") {
    return "";
  }

  const host = safeTrim(window.location.hostname).toLowerCase();
  if (LOCAL_HOSTS.has(host)) {
    return "http://localhost:8080";
  }

  return "";
})();

export const WS_BASE_URL = (() => {
  const explicit = resolveExplicitWsBaseUrl();
  if (explicit) {
    return explicit;
  }
  return API_BASE_URL;
})();
