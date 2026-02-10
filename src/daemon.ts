import { chromium, type BrowserContext } from "playwright-core";
import { existsSync, mkdirSync, readFileSync, readlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";
import { DEBUG, DebugSession, getChromeDebugArgs, setupPageDebug, dumpCookies } from "@/debug.ts";
import { Semaphore } from "@/semaphore.ts";
import {
  getSocketPath,
  getPidPath,
  getChromeProfileDir,
  getIdleTimeoutMs,
  type FetchRequest,
  type FetchResponse,
  type ErrorResponse,
  type HealthResponse,
} from "@/daemon-shared.ts";
import type { Page, CDPSession } from "playwright-core";

const MAX_CONCURRENT_TABS = 10;
const CHALLENGE_TIMEOUT_MS = 120_000;

// --- Chrome path discovery ---

const CHROME_PATHS: Record<string, string[]> = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/snap/bin/chromium",
  ],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ],
};

function findChromePath(): string | null {
  const paths = CHROME_PATHS[process.platform] ?? [];
  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  return null;
}

// --- Challenge detection & resolution ---

const CHALLENGE_TITLES = ["just a moment", "attention required"];
const CHALLENGE_SIGNATURES = [
  "captcha-delivery.com",
  "challenge-platform",
  "cf-challenge",
  "/cdn-cgi/challenge-platform",
];

function isChallengePage(title: string, html: string): boolean {
  const lowerTitle = title.toLowerCase();
  if (CHALLENGE_TITLES.some((t) => lowerTitle.includes(t))) return true;
  const lowerHtml = html.toLowerCase();
  return CHALLENGE_SIGNATURES.some((sig) => lowerHtml.includes(sig));
}

function isChallengeTitle(title: string): boolean {
  const lower = title.toLowerCase();
  return CHALLENGE_TITLES.some((t) => lower.includes(t));
}

async function waitForChallengeResolution(page: Page): Promise<string> {
  const deadline = Date.now() + CHALLENGE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1_000));
    try {
      const title = await page.title();
      if (!isChallengeTitle(title) && title.length > 0) {
        await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
        return page.content();
      }
    } catch {
      // Page might be mid-navigation — keep polling
    }
  }
  return page.content();
}

// --- Orphaned Chrome cleanup ---

export function cleanStaleChrome(profileDir: string): void {
  const lockPath = join(profileDir, "SingletonLock");
  if (!existsSync(lockPath)) return;

  let target: string;
  try {
    target = readlinkSync(lockPath);
  } catch {
    // Not a symlink or can't read — remove stale files
    removeStaleLockFiles(profileDir);
    return;
  }

  // Format: hostname-PID
  const dashIdx = target.lastIndexOf("-");
  if (dashIdx === -1) {
    removeStaleLockFiles(profileDir);
    return;
  }

  const pid = Number(target.slice(dashIdx + 1));
  if (Number.isNaN(pid) || pid <= 0) {
    removeStaleLockFiles(profileDir);
    return;
  }

  // Check if PID is alive
  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch {
    // Process doesn't exist
  }

  if (alive) {
    // Verify it's actually a Chrome process (guard against PID recycling)
    if (isChromeProcess(pid)) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Already dead
      }
      // Brief wait for Chrome to exit
      const waitDeadline = Date.now() + 3_000;
      while (Date.now() < waitDeadline) {
        try {
          process.kill(pid, 0);
        } catch {
          break; // Process is gone
        }
        Bun.sleepSync(100);
      }
    }
    // If PID is alive but not Chrome, leave it alone — just remove lock files
  }

  removeStaleLockFiles(profileDir);
}

function isChromeProcess(pid: number): boolean {
  try {
    const comm = execSync(`ps -p ${pid} -o comm=`, { encoding: "utf-8" }).trim().toLowerCase();
    return comm.includes("chrome") || comm.includes("chromium");
  } catch {
    return false;
  }
}

function removeStaleLockFiles(profileDir: string): void {
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    try {
      unlinkSync(join(profileDir, name));
    } catch {
      // Doesn't exist or already removed
    }
  }
}

// --- Browser lifecycle ---

const semaphore = new Semaphore(MAX_CONCURRENT_TABS);
let browser: BrowserContext | null = null;
let browserPending: Promise<BrowserContext> | null = null;

async function launchBrowser(): Promise<BrowserContext> {
  const userDataDir = getChromeProfileDir();
  mkdirSync(userDataDir, { recursive: true });
  cleanStaleChrome(userDataDir);

  if (process.env["BETTER_FETCH_FAKE_BROWSER"]) {
    const { launchFakeContext } = await import("@/fake-browser.ts");
    const fakeCtx = await launchFakeContext(userDataDir);
    fakeCtx.on("close", () => { browser = null; });
    browser = fakeCtx as unknown as BrowserContext;
    return browser;
  }

  const executablePath = findChromePath();
  if (!executablePath) {
    throw new Error(
      `No Chrome/Chromium binary found on this system. Looked in:\n${(CHROME_PATHS[process.platform] ?? []).join("\n")}`
    );
  }

  const ctx = await chromium.launchPersistentContext(userDataDir, {
    executablePath,
    headless: false,
    ignoreDefaultArgs: ["--enable-automation"],
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-blink-features=AutomationControlled",
      "--deny-permission-prompts",
      "--window-size=1920,1080",
      ...getChromeDebugArgs(),
    ],
    viewport: { width: 1920, height: 1080 },
    locale: "en-US",
  });

  ctx.on("close", () => {
    browser = null;
  });

  browser = ctx;
  return ctx;
}

async function getBrowser(): Promise<BrowserContext> {
  if (browser) return browser;
  if (browserPending) return browserPending;
  browserPending = launchBrowser().finally(() => { browserPending = null; });
  return browserPending;
}

// --- Fetch logic (same as old browser.ts) ---

async function handleFetch(url: string): Promise<string> {
  await semaphore.acquire();
  let page: Page | undefined;
  let debugSession: DebugSession | null = null;
  let cdpSession: CDPSession | null = null;
  try {
    const ctx = await getBrowser();
    page = await ctx.newPage();

    if (DEBUG) {
      debugSession = new DebugSession(url);
      cdpSession = await setupPageDebug(page, ctx, debugSession);
    }

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });

    const title = await page.title();
    let html = await page.content();

    if (isChallengePage(title, html)) {
      html = await waitForChallengeResolution(page);
    }

    if (debugSession) {
      debugSession.writeFile("page-final.html", html);
      if (cdpSession) await dumpCookies(cdpSession, debugSession);
      debugSession.parseChromeLog();
    }

    return html;
  } finally {
    await page?.close();
    semaphore.release();
  }
}

// --- Idle timeout ---

let idleTimer: ReturnType<typeof setTimeout> | null = null;
let inFlightRequests = 0;

function resetIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  if (inFlightRequests > 0) return; // Don't start timer while requests in flight
  idleTimer = setTimeout(() => {
    gracefulShutdown("idle timeout");
  }, getIdleTimeoutMs());
}

function requestStarted(): void {
  inFlightRequests++;
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function requestFinished(): void {
  inFlightRequests--;
  resetIdleTimer();
}

// --- Graceful shutdown ---

let shuttingDown = false;

async function gracefulShutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  // 1. Remove socket first (new clients get ECONNREFUSED immediately)
  try {
    unlinkSync(getSocketPath());
  } catch {
    // Already gone
  }

  // 2. Stop the server
  server?.stop();

  // 3. Wait briefly for in-flight requests
  const deadline = Date.now() + 5_000;
  while (inFlightRequests > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }

  // 4. Close Chrome
  if (browser) {
    try {
      await browser.close();
    } catch {
      // Already closed
    }
    browser = null;
  }

  // 5. Remove PID file
  try {
    unlinkSync(getPidPath());
  } catch {
    // Already gone
  }

  process.exit(0);
}

// Cleanup on exit (last resort) — installed only after successful bind.
// Only deletes files if this process still owns them (PID file matches),
// to avoid deleting a new daemon's socket during overlapping shutdown/startup.
function installCleanupHandlers(): void {
  const myPid = process.pid;
  process.on("exit", () => {
    try {
      const content = readFileSync(getPidPath(), "utf-8").trim();
      if (Number(content) !== myPid) return; // Another daemon owns the files now
    } catch {
      return; // PID file already gone — nothing to clean up
    }
    try { unlinkSync(getSocketPath()); } catch {}
    try { unlinkSync(getPidPath()); } catch {}
  });
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
}

// --- HTTP server ---

let server: ReturnType<typeof Bun.serve> | undefined;

function tryBind(socketPath: string): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    unix: socketPath,
    fetch: handleRequest,
    error(err) {
      return new Response(JSON.stringify({ error: String(err) }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
}

function isBindError(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === "object" &&
    "code" in err &&
    ((err as { code: string }).code === "EADDRINUSE" ||
     (err as { code: string }).code === "ENOTSOCK")
  );
}

async function main(): Promise<void> {
  const socketPath = getSocketPath();
  const pidPath = getPidPath();

  // Ensure state directory exists
  mkdirSync(dirname(socketPath), { recursive: true });

  // Try to bind directly first — this is the atomic lock
  try {
    server = tryBind(socketPath);
  } catch (err: unknown) {
    if (!isBindError(err)) throw err;

    // Socket file exists. Check if another daemon is alive on it.
    let alive = false;
    try {
      const res = await fetch("http://localhost/health", { unix: socketPath } as RequestInit);
      alive = res.ok;
    } catch {
      // Not alive
    }

    if (alive) {
      // Another daemon is running — exit silently
      process.exit(0);
    }

    // Dead socket — remove and retry once
    try { unlinkSync(socketPath); } catch {}
    try {
      server = tryBind(socketPath);
    } catch (retryErr: unknown) {
      // Another daemon won the race between unlink and bind
      if (isBindError(retryErr)) process.exit(0);
      throw retryErr;
    }
  }

  // We own the socket — install cleanup handlers now
  installCleanupHandlers();

  // Write PID file after successful bind
  writeFileSync(pidPath, String(process.pid));

  // Start idle timer
  resetIdleTimer();
}

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/health" && req.method === "GET") {
    const body: HealthResponse = {
      pid: process.pid,
      activeTabs: semaphore.active,
      queuedTabs: semaphore.queued,
    };
    return new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json" },
    });
  }

  if (url.pathname === "/fetch" && req.method === "POST") {
    requestStarted();
    try {
      const body = (await req.json()) as FetchRequest;
      if (!body.url) {
        return new Response(JSON.stringify({ error: "url is required" } satisfies ErrorResponse), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      const html = await handleFetch(body.url);
      return new Response(JSON.stringify({ html } satisfies FetchResponse), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return new Response(JSON.stringify({ error: message } satisfies ErrorResponse), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    } finally {
      requestFinished();
    }
  }

  if (url.pathname === "/shutdown" && req.method === "POST") {
    // Respond before shutting down
    const res = new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    });
    // Schedule shutdown after response is sent
    setTimeout(() => gracefulShutdown("shutdown request"), 100);
    return res;
  }

  return new Response(JSON.stringify({ error: "not found" }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });
}

// --- Entry point ---

if (import.meta.main) {
  await main();
}
