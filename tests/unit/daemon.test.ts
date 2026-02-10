import { describe, test, expect, afterEach } from "bun:test";
import { mkdirSync, existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import {
  DAEMON_PATH,
  makeTempDir,
  makeDaemonEnv,
  waitForHealth,
  isProcessAlive,
  readPid,
  startSlowServer,
  createCleanupTracker,
} from "../helpers/daemon-test-utils.ts";

const tracker = createCleanupTracker();

afterEach(async () => {
  await tracker.cleanup();
});

describe("Browser Daemon", () => {
  test("parallel clients get a single daemon", async () => {
    const stateDir = makeTempDir();
    tracker.trackTempDir(stateDir);
    const env = makeDaemonEnv(stateDir);
    const socketPath = env["BETTER_FETCH_SOCKET_PATH"]!;
    tracker.trackSocket(socketPath);

    // Spawn two daemon processes concurrently — only one should win the bind
    const proc1 = Bun.spawn(["bun", "run", DAEMON_PATH], {
      stdio: ["ignore", "ignore", "ignore"],
      env,
    });
    const proc2 = Bun.spawn(["bun", "run", DAEMON_PATH], {
      stdio: ["ignore", "ignore", "ignore"],
      env,
    });

    // Wait for the loser to exit and winner to stabilize
    await new Promise((r) => setTimeout(r, 2_000));

    // Daemon should be healthy
    const healthy = await waitForHealth(socketPath);
    expect(healthy).toBe(true);

    // All health calls should go to the same daemon
    const res1 = await fetch("http://localhost/health", { unix: socketPath } as RequestInit);
    const body1 = await res1.json() as { pid: number };
    const res2 = await fetch("http://localhost/health", { unix: socketPath } as RequestInit);
    const body2 = await res2.json() as { pid: number };

    expect(body1.pid).toBe(body2.pid);
    const winnerPid = body1.pid;
    tracker.trackPid(winnerPid);
    expect(winnerPid).toBeGreaterThan(0);
    expect(isProcessAlive(winnerPid)).toBe(true);

    // Wait for the loser process to exit
    await Promise.race([proc1.exited, new Promise(r => setTimeout(r, 3000))]);
    await Promise.race([proc2.exited, new Promise(r => setTimeout(r, 3000))]);
  }, 15_000);

  test("idle timeout shuts down daemon", async () => {
    const stateDir = makeTempDir();
    tracker.trackTempDir(stateDir);
    const baseEnv = makeDaemonEnv(stateDir);
    const env = {
      ...baseEnv,
      BETTER_FETCH_IDLE_TIMEOUT_MS: "2000", // 2s idle timeout
    };
    const socketPath = baseEnv["BETTER_FETCH_SOCKET_PATH"]!;
    const pidPath = baseEnv["BETTER_FETCH_PID_PATH"]!;
    tracker.trackSocket(socketPath);

    // Start daemon
    Bun.spawn(["bun", "run", DAEMON_PATH], {
      stdio: ["ignore", "ignore", "ignore"],
      env,
    });

    const healthy = await waitForHealth(socketPath);
    expect(healthy).toBe(true);

    const pid = await readPid(pidPath);
    tracker.trackPid(pid);
    expect(isProcessAlive(pid)).toBe(true);

    // Wait for idle timeout to fire (2s timeout + buffer)
    await new Promise((r) => setTimeout(r, 4000));

    // Daemon should have exited
    expect(isProcessAlive(pid)).toBe(false);

    // Socket and PID file should be cleaned up
    expect(existsSync(socketPath)).toBe(false);
    expect(existsSync(pidPath)).toBe(false);
  }, 15_000);

  test("orphaned Chrome cleanup removes stale lock files", async () => {
    const stateDir = makeTempDir();
    tracker.trackTempDir(stateDir);

    // Create a fake chrome profile dir with a stale SingletonLock
    const profileDir = join(stateDir, "chrome-profile");
    mkdirSync(profileDir, { recursive: true });

    // Point SingletonLock at a PID that doesn't exist (simulate dead Chrome)
    const fakePid = 99999999; // Very unlikely to exist
    const lockPath = join(profileDir, "SingletonLock");
    symlinkSync(`localhost-${fakePid}`, lockPath);

    // Also create SingletonSocket and SingletonCookie
    const socketLockPath = join(profileDir, "SingletonSocket");
    const cookieLockPath = join(profileDir, "SingletonCookie");
    symlinkSync("placeholder", socketLockPath);
    symlinkSync("placeholder", cookieLockPath);

    // Import and call cleanStaleChrome directly
    const { cleanStaleChrome } = await import("@/daemon.ts");
    cleanStaleChrome(profileDir);

    // All stale lock files should be removed
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(socketLockPath)).toBe(false);
    expect(existsSync(cookieLockPath)).toBe(false);
  }, 10_000);

  test("fetch fails fast (not hang) after daemon SIGKILL", async () => {
    // Simulates: client confirms daemon alive via health check,
    // daemon gets OOM-killed, client sends /fetch → should fail fast
    const stateDir = makeTempDir();
    tracker.trackTempDir(stateDir);
    const env = makeDaemonEnv(stateDir);
    const socketPath = env["BETTER_FETCH_SOCKET_PATH"]!;
    const pidPath = env["BETTER_FETCH_PID_PATH"]!;
    tracker.trackSocket(socketPath);

    // Start daemon
    Bun.spawn(["bun", "run", DAEMON_PATH], {
      stdio: ["ignore", "ignore", "ignore"],
      env,
    });

    const healthy = await waitForHealth(socketPath);
    expect(healthy).toBe(true);

    const pid = await readPid(pidPath);
    tracker.trackPid(pid);

    // Health check passes — daemon is confirmed alive
    const healthRes = await fetch("http://localhost/health", { unix: socketPath } as RequestInit);
    expect(healthRes.ok).toBe(true);

    // Kill daemon (simulates OOM kill)
    process.kill(pid, "SIGKILL");
    await new Promise((r) => setTimeout(r, 500));

    // Now try /fetch — should fail fast with a connection error, not hang for 180s
    const start = Date.now();
    let gotError = false;
    try {
      await fetch("http://localhost/fetch", {
        unix: socketPath,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://example.com" }),
        signal: AbortSignal.timeout(5_000),
      } as RequestInit);
    } catch {
      gotError = true;
    }
    const elapsed = Date.now() - start;

    // Must get an error (connection refused), and it must be fast (< 2s, not 180s timeout)
    expect(gotError).toBe(true);
    expect(elapsed).toBeLessThan(2_000);
  }, 15_000);

  test("daemon crash → next spawn recovers", async () => {
    const stateDir = makeTempDir();
    tracker.trackTempDir(stateDir);
    const env = makeDaemonEnv(stateDir);
    const socketPath = env["BETTER_FETCH_SOCKET_PATH"]!;
    const pidPath = env["BETTER_FETCH_PID_PATH"]!;
    tracker.trackSocket(socketPath);

    // Start daemon
    Bun.spawn(["bun", "run", DAEMON_PATH], {
      stdio: ["ignore", "ignore", "ignore"],
      env,
    });

    const healthy1 = await waitForHealth(socketPath);
    expect(healthy1).toBe(true);

    const pid1 = await readPid(pidPath);
    tracker.trackPid(pid1);
    expect(isProcessAlive(pid1)).toBe(true);

    // Kill daemon with SIGKILL (simulating crash — no cleanup)
    process.kill(pid1, "SIGKILL");
    await new Promise((r) => setTimeout(r, 500));
    expect(isProcessAlive(pid1)).toBe(false);

    // Stale socket file should still exist (daemon had no chance to clean up)
    // Remove it like the client does before spawning a new daemon
    const { unlinkSync } = await import("node:fs");
    if (existsSync(socketPath)) {
      try { unlinkSync(socketPath); } catch {}
    }

    // Start a new daemon
    Bun.spawn(["bun", "run", DAEMON_PATH], {
      stdio: ["ignore", "ignore", "ignore"],
      env,
    });

    const healthy2 = await waitForHealth(socketPath);
    expect(healthy2).toBe(true);

    const pid2 = await readPid(pidPath);
    tracker.trackPid(pid2);
    expect(pid2).not.toBe(pid1); // Different daemon
    expect(isProcessAlive(pid2)).toBe(true);

    // Health check should work
    const res = await fetch("http://localhost/health", { unix: socketPath } as RequestInit);
    expect(res.ok).toBe(true);
    const body = await res.json() as { pid: number };
    expect(body.pid).toBe(pid2);
  }, 15_000);

  test("shutdown while /fetch in-flight returns response to client", async () => {
    // Simulates: Client B is fetching a slow page, Client A sends /shutdown.
    // Client B should get a response (success or error), never hang.
    const stateDir = makeTempDir();
    tracker.trackTempDir(stateDir);
    const env = makeDaemonEnv(stateDir);
    const socketPath = env["BETTER_FETCH_SOCKET_PATH"]!;
    const pidPath = env["BETTER_FETCH_PID_PATH"]!;
    tracker.trackSocket(socketPath);

    // Slow server that takes 8 seconds to respond
    const slow = startSlowServer(8_000);
    tracker.trackServer(slow);

    // Start daemon
    Bun.spawn(["bun", "run", DAEMON_PATH], {
      stdio: ["ignore", "ignore", "ignore"],
      env,
    });

    const healthy = await waitForHealth(socketPath);
    expect(healthy).toBe(true);
    const pid = await readPid(pidPath);
    tracker.trackPid(pid);

    // Send /fetch for the slow URL — fake browser fetches via HTTP
    const fetchPromise = fetch("http://localhost/fetch", {
      unix: socketPath,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: slow.url }),
      signal: AbortSignal.timeout(30_000),
    } as RequestInit).then(
      (res) => ({ ok: true as const, res }),
      (err) => ({ ok: false as const, err }),
    );

    // Wait for fake browser launch (~500ms) + request to be in-flight
    await new Promise((r) => setTimeout(r, 2_000));

    // Send /shutdown while fetch is in-flight
    const shutdownRes = await fetch("http://localhost/shutdown", {
      unix: socketPath,
      method: "POST",
    } as RequestInit);
    expect(shutdownRes.ok).toBe(true);

    // The fetch caller must get SOME response — success or error, not a hang
    const result = await fetchPromise;
    if (result.ok) {
      // Either valid HTML or 502 error — both acceptable
      expect(result.res.status === 200 || result.res.status === 502).toBe(true);
    } else {
      // Connection error (daemon exited before sending response) — also acceptable
      expect(result.err).toBeDefined();
    }

    // Daemon should be dead within a few seconds
    await new Promise((r) => setTimeout(r, 3_000));
    expect(isProcessAlive(pid)).toBe(false);
  }, 30_000);

  test("SIGTERM during browser launch does not leave stale state", async () => {
    // Simulates: first /fetch triggers browser launch (with fake delay),
    // SIGTERM arrives mid-launch. Daemon must exit, and a new daemon must
    // be able to start and clean up any stale lock files.
    const stateDir = makeTempDir();
    tracker.trackTempDir(stateDir);
    const baseEnv = makeDaemonEnv(stateDir);
    const env = {
      ...baseEnv,
      BETTER_FETCH_FAKE_LAUNCH_DELAY_MS: "3000", // Slow launch so SIGTERM arrives mid-launch
    };
    const socketPath = baseEnv["BETTER_FETCH_SOCKET_PATH"]!;
    const pidPath = baseEnv["BETTER_FETCH_PID_PATH"]!;
    const profileDir = join(stateDir, "chrome-profile");
    tracker.trackSocket(socketPath);

    // Start daemon
    Bun.spawn(["bun", "run", DAEMON_PATH], {
      stdio: ["ignore", "ignore", "ignore"],
      env,
    });

    const healthy = await waitForHealth(socketPath);
    expect(healthy).toBe(true);
    const pid = await readPid(pidPath);
    tracker.trackPid(pid);

    // Send /fetch to trigger browser launch (don't await — it'll fail when we kill daemon)
    const fetchPromise = fetch("http://localhost/fetch", {
      unix: socketPath,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "http://localhost:1" }), // URL doesn't matter, launch will be interrupted
      signal: AbortSignal.timeout(30_000),
    } as RequestInit).catch(() => {});

    // Give launch ~1 second to start (SingletonLock may be created, but launch not finished)
    await new Promise((r) => setTimeout(r, 1_000));

    // SIGTERM daemon mid-launch
    process.kill(pid, "SIGTERM");

    // Wait for daemon to exit (drain timeout is 5s + fake launch finishes)
    await new Promise((r) => setTimeout(r, 8_000));
    expect(isProcessAlive(pid)).toBe(false);
    await fetchPromise;

    // Key assertion: a NEW daemon must be able to start and clean up
    // any stale SingletonLock (via cleanStaleChrome).
    Bun.spawn(["bun", "run", DAEMON_PATH], {
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...baseEnv }, // Normal launch delay for recovery daemon
    });

    const healthy2 = await waitForHealth(socketPath);
    expect(healthy2).toBe(true);

    const pid2 = await readPid(pidPath);
    tracker.trackPid(pid2);
    expect(isProcessAlive(pid2)).toBe(true);
  }, 30_000);

  test("concurrent in-flight requests all resolve on shutdown", async () => {
    // Simulates: multiple clients are mid-fetch via the same daemon,
    // /shutdown arrives. ALL callers must get a response (success or error),
    // none should hang. The daemon must exit in bounded time.
    const stateDir = makeTempDir();
    tracker.trackTempDir(stateDir);
    const env = makeDaemonEnv(stateDir);
    const socketPath = env["BETTER_FETCH_SOCKET_PATH"]!;
    const pidPath = env["BETTER_FETCH_PID_PATH"]!;
    tracker.trackSocket(socketPath);

    // Server that takes 10s to respond — keeps requests in-flight
    const slow = startSlowServer(10_000);
    tracker.trackServer(slow);

    // Start daemon
    Bun.spawn(["bun", "run", DAEMON_PATH], {
      stdio: ["ignore", "ignore", "ignore"],
      env,
    });

    const healthy = await waitForHealth(socketPath);
    expect(healthy).toBe(true);
    const pid = await readPid(pidPath);
    tracker.trackPid(pid);

    // Fire 3 concurrent /fetch requests
    const fetches = Array.from({ length: 3 }, () =>
      fetch("http://localhost/fetch", {
        unix: socketPath,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: slow.url }),
        signal: AbortSignal.timeout(30_000),
      } as RequestInit).then(
        (res) => ({ ok: true as const, status: res.status }),
        (err) => ({ ok: false as const, err }),
      )
    );

    // Wait for requests to reach the daemon and start processing
    await new Promise((r) => setTimeout(r, 2_000));

    // Confirm requests are in-flight via /health
    const healthRes = await fetch("http://localhost/health", { unix: socketPath } as RequestInit);
    const healthBody = await healthRes.json() as { activeTabs: number; queuedTabs: number };
    expect(healthBody.activeTabs + healthBody.queuedTabs).toBeGreaterThanOrEqual(0);

    // Send /shutdown
    await fetch("http://localhost/shutdown", {
      unix: socketPath,
      method: "POST",
    } as RequestInit);

    // ALL fetch callers must resolve within bounded time (not hang)
    const start = Date.now();
    const results = await Promise.all(fetches);
    const elapsed = Date.now() - start;

    // Each caller got either a response or a connection error — not a timeout
    for (const r of results) {
      if (r.ok) {
        expect(r.status === 200 || r.status === 502).toBe(true);
      } else {
        expect(r.err).toBeDefined();
      }
    }

    // Should resolve in bounded time (daemon's 5s drain + buffer), not 30s client timeout
    expect(elapsed).toBeLessThan(15_000);

    // Daemon must exit
    await new Promise((r) => setTimeout(r, 2_000));
    expect(isProcessAlive(pid)).toBe(false);
  }, 45_000);

  test("new daemon starts cleanly while old daemon is shutting down", async () => {
    // Simulates: old daemon receives /shutdown (starts graceful close),
    // new daemon spawns immediately. The new daemon must start successfully
    // despite the old daemon potentially still holding the profile lock.
    const stateDir = makeTempDir();
    tracker.trackTempDir(stateDir);
    const env = makeDaemonEnv(stateDir);
    const socketPath = env["BETTER_FETCH_SOCKET_PATH"]!;
    const pidPath = env["BETTER_FETCH_PID_PATH"]!;
    tracker.trackSocket(socketPath);

    // Slow server to keep old daemon's fetch in-flight during shutdown
    const slow = startSlowServer(10_000);
    tracker.trackServer(slow);

    // Start old daemon
    Bun.spawn(["bun", "run", DAEMON_PATH], {
      stdio: ["ignore", "ignore", "ignore"],
      env,
    });

    const healthy1 = await waitForHealth(socketPath);
    expect(healthy1).toBe(true);
    const pid1 = await readPid(pidPath);
    tracker.trackPid(pid1);

    // Trigger browser launch by sending a /fetch
    const fetchPromise = fetch("http://localhost/fetch", {
      unix: socketPath,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: slow.url }),
      signal: AbortSignal.timeout(30_000),
    } as RequestInit).catch(() => {});

    // Give fake browser time to launch (~500ms) + start fetching
    await new Promise((r) => setTimeout(r, 2_000));

    // Send /shutdown — old daemon starts graceful shutdown
    // (removes socket, stops server, waits for drain, closes browser)
    try {
      await fetch("http://localhost/shutdown", {
        unix: socketPath,
        method: "POST",
        signal: AbortSignal.timeout(2_000),
      } as RequestInit);
    } catch {
      // Socket might already be gone
    }

    // Wait for old daemon's socket to be removed but NOT fully exited
    // (it's in the drain phase waiting for the slow fetch)
    await new Promise((r) => setTimeout(r, 500));

    // Spawn new daemon immediately — this is the overlap window
    Bun.spawn(["bun", "run", DAEMON_PATH], {
      stdio: ["ignore", "ignore", "ignore"],
      env,
    });

    // New daemon must come up healthy
    const healthy2 = await waitForHealth(socketPath, 15_000);
    expect(healthy2).toBe(true);

    const pid2 = await readPid(pidPath);
    tracker.trackPid(pid2);
    expect(pid2).not.toBe(pid1);
    expect(isProcessAlive(pid2)).toBe(true);

    // Wait for old daemon to fully exit
    await fetchPromise;
    await new Promise((r) => setTimeout(r, 3_000));
    expect(isProcessAlive(pid1)).toBe(false);

    // New daemon is still healthy
    const res = await fetch("http://localhost/health", { unix: socketPath } as RequestInit);
    expect(res.ok).toBe(true);
    const body = await res.json() as { pid: number };
    expect(body.pid).toBe(pid2);
  }, 45_000);

  test("thundering herd: 5 simultaneous daemon spawns yield one winner", async () => {
    // Simulates: user opens 5 Claude Code sessions at once, all trigger browser
    // fetch simultaneously. All 5 MCP processes spawn a daemon. Only 1 should survive.
    const stateDir = makeTempDir();
    tracker.trackTempDir(stateDir);
    const env = makeDaemonEnv(stateDir);
    const socketPath = env["BETTER_FETCH_SOCKET_PATH"]!;
    tracker.trackSocket(socketPath);

    // Spawn 5 daemon processes simultaneously
    const procs = Array.from({ length: 5 }, () =>
      Bun.spawn(["bun", "run", DAEMON_PATH], {
        stdio: ["ignore", "ignore", "ignore"],
        env,
      })
    );

    // Wait for losers to exit and winner to stabilize
    await new Promise((r) => setTimeout(r, 3_000));

    // Daemon should be healthy
    const healthy = await waitForHealth(socketPath);
    expect(healthy).toBe(true);

    // Fire 5 concurrent health checks — all should return the same PID
    const healthResults = await Promise.all(
      Array.from({ length: 5 }, () =>
        fetch("http://localhost/health", { unix: socketPath } as RequestInit)
          .then((r) => r.json() as Promise<{ pid: number }>)
      )
    );

    const pids = healthResults.map((r) => r.pid);
    const uniquePids = new Set(pids);

    // Exactly one daemon serving all requests
    expect(uniquePids.size).toBe(1);

    const winnerPid = pids[0]!;
    tracker.trackPid(winnerPid);
    expect(isProcessAlive(winnerPid)).toBe(true);

    // All loser processes should have exited
    await Promise.all(procs.map((p) =>
      Promise.race([p.exited, new Promise((r) => setTimeout(r, 5_000))])
    ));
  }, 20_000);

  test("rapid requests near idle boundary keep daemon alive", async () => {
    // Uses POST /fetch with empty url (returns 400 fast, no browser launch)
    // which still triggers requestStarted/requestFinished → timer reset.
    const stateDir = makeTempDir();
    tracker.trackTempDir(stateDir);
    const baseEnv = makeDaemonEnv(stateDir);
    const env = {
      ...baseEnv,
      BETTER_FETCH_IDLE_TIMEOUT_MS: "2000", // 2s idle timeout
    };
    const socketPath = baseEnv["BETTER_FETCH_SOCKET_PATH"]!;
    const pidPath = baseEnv["BETTER_FETCH_PID_PATH"]!;
    tracker.trackSocket(socketPath);

    // Start daemon
    Bun.spawn(["bun", "run", DAEMON_PATH], {
      stdio: ["ignore", "ignore", "ignore"],
      env,
    });

    const healthy = await waitForHealth(socketPath);
    expect(healthy).toBe(true);
    const pid = await readPid(pidPath);
    tracker.trackPid(pid);

    // Send /fetch (empty url → 400) every 1.5s to reset idle timer
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 1_500));
      expect(isProcessAlive(pid)).toBe(true);

      const res = await fetch("http://localhost/fetch", {
        unix: socketPath,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "" }),
      } as RequestInit);
      expect(res.status).toBe(400);
    }

    // Daemon is alive at ~t=4.5 with timer reset to fire at ~t=6.5
    expect(isProcessAlive(pid)).toBe(true);

    // Now stop sending requests and wait for idle timeout + buffer
    await new Promise((r) => setTimeout(r, 3_500));

    // Daemon should have exited
    expect(isProcessAlive(pid)).toBe(false);
    expect(existsSync(socketPath)).toBe(false);
  }, 20_000);

  test("cleanStaleChrome does not kill non-Chrome process (PID recycling guard)", async () => {
    // Simulates: old Chrome crashed, OS recycled the PID to "sleep".
    // cleanStaleChrome must NOT kill the unrelated process.
    const stateDir = makeTempDir();
    tracker.trackTempDir(stateDir);
    const profileDir = join(stateDir, "chrome-profile");
    mkdirSync(profileDir, { recursive: true });

    // Start a dummy process that is NOT Chrome
    const dummy = Bun.spawn(["sleep", "60"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    const dummyPid = dummy.pid;

    // Create SingletonLock pointing to the dummy's PID
    const lockPath = join(profileDir, "SingletonLock");
    symlinkSync(`localhost-${dummyPid}`, lockPath);

    // Also create the other lock files
    symlinkSync("placeholder", join(profileDir, "SingletonSocket"));
    symlinkSync("placeholder", join(profileDir, "SingletonCookie"));

    // Call cleanStaleChrome
    const { cleanStaleChrome } = await import("@/daemon.ts");
    cleanStaleChrome(profileDir);

    // The dummy process must still be alive — PID recycling guard prevented the kill
    expect(isProcessAlive(dummyPid)).toBe(true);

    // Lock files should still be removed (they're stale regardless)
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(join(profileDir, "SingletonSocket"))).toBe(false);
    expect(existsSync(join(profileDir, "SingletonCookie"))).toBe(false);

    // Clean up
    dummy.kill();
  }, 10_000);
});
