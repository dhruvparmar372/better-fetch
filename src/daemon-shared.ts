import { join } from "node:path";
import { homedir } from "node:os";

// --- Path getters (env var overrides for test isolation) ---

export function getStateDir(): string {
  const override = process.env["BETTER_FETCH_STATE_DIR"];
  if (override) return override;

  const xdgState = process.env["XDG_STATE_HOME"];
  const base = xdgState || join(homedir(), ".local", "state");
  return join(base, "better-fetch");
}

export function getSocketPath(): string {
  return process.env["BETTER_FETCH_SOCKET_PATH"] || join(getStateDir(), "browser.sock");
}

export function getPidPath(): string {
  return process.env["BETTER_FETCH_PID_PATH"] || join(getStateDir(), "browser.pid");
}

export function getChromeProfileDir(): string {
  return join(getStateDir(), "chrome-profile");
}

export function getIdleTimeoutMs(): number {
  const override = process.env["BETTER_FETCH_IDLE_TIMEOUT_MS"];
  if (override) return Number(override);
  return 300_000; // 5 minutes
}

// --- Protocol types ---

export interface FetchRequest {
  url: string;
}

export interface FetchResponse {
  html: string;
}

export interface ErrorResponse {
  error: string;
}

export interface HealthResponse {
  pid: number;
  activeTabs: number;
  queuedTabs: number;
}
