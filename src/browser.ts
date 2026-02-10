import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { getSocketPath, type FetchResponse, type ErrorResponse } from "@/daemon-shared.ts";

const DAEMON_STARTUP_TIMEOUT_MS = 10_000;
const FETCH_TIMEOUT_MS = 180_000;
const HEALTH_POLL_INTERVAL_MS = 200;

// --- Daemon health check ---

async function isDaemonRunning(): Promise<boolean> {
  try {
    const res = await fetch("http://localhost/health", {
      unix: getSocketPath(),
    } as RequestInit);
    return res.ok;
  } catch {
    return false;
  }
}

// --- Daemon lifecycle ---

async function ensureDaemon(): Promise<void> {
  if (await isDaemonRunning()) return;

  // Clean up stale socket if daemon crashed
  const socketPath = getSocketPath();
  if (existsSync(socketPath)) {
    try {
      unlinkSync(socketPath);
    } catch {
      // Race with another client cleaning up
    }
  }

  // Spawn daemon as detached child
  const daemonPath = resolve(import.meta.dir, "daemon.ts");

  // Forward relevant env vars to the daemon
  const env: Record<string, string> = { ...process.env } as Record<string, string>;

  const proc = Bun.spawn(["bun", "run", daemonPath], {
    stdio: ["ignore", "ignore", "ignore"],
    env,
  });
  proc.unref();

  // Poll until daemon is ready
  const deadline = Date.now() + DAEMON_STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isDaemonRunning()) return;
    await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
  }

  throw new Error("Browser daemon failed to start within timeout");
}

// --- Public API (same exports as before) ---

export async function fetchWithBrowser(url: string): Promise<string> {
  await ensureDaemon();

  const res = await fetch("http://localhost/fetch", {
    unix: getSocketPath(),
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  } as RequestInit);

  if (!res.ok) {
    const body = (await res.json()) as ErrorResponse;
    throw new Error(`Browser fetch failed: ${body.error}`);
  }

  const body = (await res.json()) as FetchResponse;
  return body.html;
}

export async function closeBrowser(): Promise<void> {
  if (!(await isDaemonRunning())) return;

  try {
    await fetch("http://localhost/shutdown", {
      unix: getSocketPath(),
      method: "POST",
    } as RequestInit);
  } catch {
    // Daemon already gone
  }
}
