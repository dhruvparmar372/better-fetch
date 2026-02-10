import { chromium, type BrowserContext } from "playwright-core";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { DEBUG, DebugSession, getChromeDebugArgs, setupPageDebug, dumpCookies } from "@/debug.ts";
import { Semaphore } from "@/semaphore.ts";
import { LazySingleton } from "@/lazy-singleton.ts";
import type { Page, CDPSession } from "playwright-core";

const MAX_CONCURRENT_TABS = 10;
const CHALLENGE_TIMEOUT_MS = 120_000;

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

// --- Singleton persistent browser context ---

function getStateDir(): string {
  const xdgState = process.env["XDG_STATE_HOME"];
  const base = xdgState || join(homedir(), ".local", "state");
  return join(base, "better-fetch", "chrome-profile");
}

const semaphore = new Semaphore(MAX_CONCURRENT_TABS);

const browserSingleton = new LazySingleton<BrowserContext>(async () => {
  const executablePath = findChromePath();
  if (!executablePath) {
    throw new Error(
      `No Chrome/Chromium binary found on this system. Looked in:\n${(CHROME_PATHS[process.platform] ?? []).join("\n")}`
    );
  }

  // Persistent context keeps cookies (including cf_clearance) across restarts
  const userDataDir = getStateDir();
  mkdirSync(userDataDir, { recursive: true });

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
    browserSingleton.clear();
  });

  return ctx;
});

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

async function waitForChallengeResolution(
  page: Page,
): Promise<string> {
  // Poll page.title() from Node-side rather than injecting JS into the page.
  // The in-page execution context gets destroyed when Cloudflare navigates
  // after solving the challenge, which breaks waitForFunction silently.
  const deadline = Date.now() + CHALLENGE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1_000));
    try {
      const title = await page.title();
      if (!isChallengeTitle(title) && title.length > 0) {
        // Challenge resolved — let the page finish loading
        await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
        return page.content();
      }
    } catch {
      // Page might be mid-navigation — keep polling
    }
  }
  return page.content();
}

// --- Public API ---

export async function fetchWithBrowser(url: string): Promise<string> {
  await semaphore.acquire();
  let page: Page | undefined;
  let debugSession: DebugSession | null = null;
  let cdpSession: CDPSession | null = null;
  try {
    const ctx = await browserSingleton.get();
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

export async function closeBrowser(): Promise<void> {
  const ctx = browserSingleton.current;
  if (ctx) {
    await ctx.close();
  }
  browserSingleton.clear();
  semaphore.reset();
}
