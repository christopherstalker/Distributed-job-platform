import { API_BASE_URL, WS_BASE_URL } from "../api/config";
import { safeTrim } from "./safe";

function getEnvValue(key: string) {
  const env = import.meta.env as Record<string, unknown>;
  return safeTrim(env[key]);
}

export function resolveDefaultApiBaseUrl() {
  return API_BASE_URL;
}

export function resolveDefaultRealtimeBaseUrl(_apiBaseUrl?: string) {
  return WS_BASE_URL;
}

export function resolveDefaultAdminToken() {
  return safeTrim(getEnvValue("VITE_ADMIN_TOKEN") || getEnvValue("NEXT_PUBLIC_ADMIN_TOKEN")) || "dev-admin-token";
}
