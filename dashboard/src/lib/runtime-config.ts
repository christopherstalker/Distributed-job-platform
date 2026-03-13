const trimTrailingSlash = (value: string) => value.replace(/\/+$/, "");

const apiBase = trimTrailingSlash(import.meta.env.VITE_API_URL || "");
const explicitWsBase = trimTrailingSlash(import.meta.env.VITE_WS_URL || "");
const adminToken = (import.meta.env.VITE_ADMIN_TOKEN || "").trim();

if (import.meta.env.PROD && !apiBase) {
  console.warn("VITE_API_URL is missing in production");
}

export const API_BASE_URL =
  apiBase || (import.meta.env.PROD ? "" : "http://localhost:8080");

export const WS_BASE_URL =
  explicitWsBase ||
  API_BASE_URL.replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://");

export const apiUrl = (path: string) =>
  `${API_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;

export const wsUrl = (path: string) =>
  `${WS_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;

export const resolveDefaultApiBase = () => API_BASE_URL;
export const resolveDefaultRealtimeBase = () => WS_BASE_URL;
export const resolveDefaultAdminToken = () => adminToken;
