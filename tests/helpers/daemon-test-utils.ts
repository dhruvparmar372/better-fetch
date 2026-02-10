/**
 * Shared test utilities for daemon tests.
 * Used by both tests/unit/daemon.test.ts and tests/daemon/daemon.test.ts
 */
import { mkdirSync, rmSync, existsSync, readFileSync, readlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

export const DAEMON_PATH = resolve(import.meta.dir, "../../src/daemon.ts");

export function makeTempDir(): string {
  // Keep path short — macOS has a 104-byte limit for Unix socket paths
  const id = Math.random().toString(36).slice(2, 8);
  const dir = join(tmpdir(), `bf-${id}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function makeDaemonEnv(stateDir: string): Record<string, string> {
  const socketPath = join(stateDir, "browser.sock");
  const pidPath = join(stateDir, "browser.pid");
  return {
    ...process.env as Record<string, string>,
    BETTER_FETCH_STATE_DIR: stateDir,
    BETTER_FETCH_SOCKET_PATH: socketPath,
    BETTER_FETCH_PID_PATH: pidPath,
    BETTER_FETCH_FAKE_BROWSER: "1",
  };
}

export async function sendShutdown(socketPath: string): Promise<void> {
  try {
    await fetch("http://localhost/shutdown", {
      unix: socketPath,
      method: "POST",
    } as RequestInit);
  } catch {
    // Already dead
  }
  // Wait briefly for process to exit
  await new Promise((r) => setTimeout(r, 500));
}

export async function waitForHealth(socketPath: string, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch("http://localhost/health", {
        unix: socketPath,
      } as RequestInit);
      if (res.ok) return true;
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function readPid(pidPath: string, timeoutMs = 10_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const content = readFileSync(pidPath, "utf-8").trim();
      const pid = Number(content);
      if (!Number.isNaN(pid) && pid > 0) return pid;
    } catch {
      // File not yet written
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("PID file not written within timeout");
}

/** Start a local HTTP server with a configurable delay */
export function startSlowServer(delayMs: number): { url: string; stop: () => void } {
  const server = Bun.serve({
    port: 0, // random available port
    fetch: async () => {
      await new Promise((r) => setTimeout(r, delayMs));
      return new Response("<html><head><title>Slow Page</title></head><body>OK</body></html>", {
        headers: { "Content-Type": "text/html" },
      });
    },
  });
  const url = `http://localhost:${server.port}/`;
  return { url, stop: () => server.stop() };
}

/** Kill orphaned Chrome processes using a specific profile directory */
export function killOrphanedChrome(profileDir: string): void {
  const lockPath = join(profileDir, "SingletonLock");
  if (!existsSync(lockPath)) return;
  try {
    const target = readlinkSync(lockPath);
    const dashIdx = target.lastIndexOf("-");
    if (dashIdx === -1) return;
    const pid = Number(target.slice(dashIdx + 1));
    if (!Number.isNaN(pid) && pid > 0) {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
  } catch {
    // Can't read lock — nothing to do
  }
}

/**
 * Cleanup tracker for daemon tests. Call installCleanup(afterEach) in your
 * describe block and use the track* methods to register resources.
 */
export function createCleanupTracker() {
  const tempDirs: string[] = [];
  const daemonPids: number[] = [];
  const daemonSockets: string[] = [];
  const testServers: Array<{ stop: () => void }> = [];

  return {
    tempDirs,
    daemonPids,
    daemonSockets,
    testServers,

    trackTempDir(dir: string) { tempDirs.push(dir); },
    trackPid(pid: number) { daemonPids.push(pid); },
    trackSocket(socketPath: string) { daemonSockets.push(socketPath); },
    trackServer(server: { stop: () => void }) { testServers.push(server); },

    async cleanup() {
      // Stop test HTTP servers
      for (const s of testServers) {
        try { s.stop(); } catch {}
      }
      testServers.length = 0;

      // Shut down any daemons we started
      for (const sock of daemonSockets) {
        await sendShutdown(sock).catch(() => {});
      }
      daemonSockets.length = 0;

      // Kill any leftover daemon processes
      for (const pid of daemonPids) {
        try { process.kill(pid, "SIGKILL"); } catch {}
      }
      daemonPids.length = 0;

      // Kill orphaned Chrome from temp profile dirs, then clean up
      for (const dir of tempDirs) {
        killOrphanedChrome(join(dir, "chrome-profile"));
        try { rmSync(dir, { recursive: true, force: true }); } catch {}
      }
      tempDirs.length = 0;
    },
  };
}
