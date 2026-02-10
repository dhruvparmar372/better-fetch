import { mkdirSync, writeFileSync, readFileSync, appendFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import type { Page, BrowserContext, CDPSession } from "playwright-core";

// Debug logging — disabled by default; set BETTER_FETCH_DEBUG=1 to enable.
export const DEBUG = process.env["BETTER_FETCH_DEBUG"] === "1";

const DEFAULT_DEBUG_DIR = join(process.cwd(), "debug");
let debugBaseDir = DEFAULT_DEBUG_DIR;
const CHROME_LOG_PATH = join(DEFAULT_DEBUG_DIR, "chrome.log");

export function setDebugBaseDir(dir: string): void {
  debugBaseDir = dir;
}

export function getDebugBaseDir(): string {
  return debugBaseDir;
}

export function resetDebugBaseDir(): void {
  debugBaseDir = DEFAULT_DEBUG_DIR;
}

// ---------------------------------------------------------------------------
// Chrome launch args
// ---------------------------------------------------------------------------

export function getChromeDebugArgs(): string[] {
  if (!DEBUG) return [];
  mkdirSync(DEFAULT_DEBUG_DIR, { recursive: true });
  return [
    "--enable-logging",
    "--v=1",
    `--log-file=${CHROME_LOG_PATH}`,
  ];
}

// ---------------------------------------------------------------------------
// DebugSession — one per fetchWithBrowser() call
// ---------------------------------------------------------------------------

export class DebugSession {
  readonly dir: string;
  private startTime: number;
  private chromeLogStartOffset: number;

  constructor(url: string) {
    this.startTime = Date.now();

    // Record current chrome.log size so parseChromeLog() reads only this session's entries
    try {
      this.chromeLogStartOffset = statSync(CHROME_LOG_PATH).size;
    } catch {
      this.chromeLogStartOffset = 0;
    }

    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    let hostname: string;
    try {
      hostname = new URL(url).hostname;
    } catch {
      hostname = "unknown";
    }
    this.dir = join(debugBaseDir, `${ts}_${hostname}`);
    mkdirSync(this.dir, { recursive: true });

    writeFileSync(
      join(this.dir, "meta.json"),
      JSON.stringify({ url, startedAt: new Date().toISOString() }, null, 2),
    );
  }

  /** Append a JSONL entry to a file in the session directory. */
  log(file: string, data: Record<string, unknown>): void {
    const elapsed = Date.now() - this.startTime;
    appendFileSync(
      join(this.dir, file),
      JSON.stringify({ _ms: elapsed, ...data }) + "\n",
    );
  }

  writeFile(name: string, content: string): void {
    writeFileSync(join(this.dir, name), content);
  }

  saveSource(filename: string, content: string): void {
    const dir = join(this.dir, "sources");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, filename), content);
  }

  /**
   * Parse chrome.log and extract CONSOLE entries.
   *
   * chrome.log at --v=1 reliably provides:
   * - CONSOLE entries (all console.* calls with source URL + line number)
   *
   * It does NOT provide (these come from CDP instead):
   * - HTTP response status/headers
   * - Cookie values / Set-Cookie headers
   * - Navigation lifecycle events
   * - Request/response bodies
   */
  parseChromeLog(): void {
    // Read only the bytes appended during this session's lifetime
    let fd: number;
    try {
      fd = openSync(CHROME_LOG_PATH, "r");
    } catch {
      return;
    }

    let raw: string;
    try {
      const fileSize = statSync(CHROME_LOG_PATH).size;
      const length = fileSize - this.chromeLogStartOffset;
      if (length <= 0) { closeSync(fd); return; }

      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, this.chromeLogStartOffset);
      raw = buffer.toString("utf-8");
    } finally {
      closeSync(fd);
    }

    // Write this session's slice of chrome.log into the session directory
    writeFileSync(join(this.dir, "chrome.log"), raw);

    const consoleOut = join(this.dir, "console.jsonl");

    for (const line of raw.split("\n")) {
      const parsed = parseChromeLogLine(line);
      if (!parsed || parsed.source !== "CONSOLE") continue;

      const { ts, level, text } = parsed;
      // Chrome CONSOLE format: "message", source: <url> (<line>)
      const m = text.match(/^"(.*)",\s*source:\s*(.+)\s+\((\d+)\)$/s);
      if (m) {
        appendFileSync(consoleOut,
          JSON.stringify({ ts, level, message: m[1], url: m[2], line: Number(m[3]) }) + "\n");
      } else {
        appendFileSync(consoleOut,
          JSON.stringify({ ts, level, message: text }) + "\n");
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Chrome log line parser
// ---------------------------------------------------------------------------

// Format: [PID:TID:MMDD/HHMMSS.FFFFFF:LEVEL:SOURCE:LINE] message
const CHROME_LOG_RE = /^\[(\d+:\d+:\d{4}\/\d{6}\.\d+):(\w+):([^\]]+)\]\s(.*)$/;

interface ChromeLogEntry {
  ts: string;
  level: string;
  source: string;
  text: string;
}

function parseChromeLogLine(line: string): ChromeLogEntry | null {
  const m = line.match(CHROME_LOG_RE);
  if (!m) return null;
  const sourceFull = m[3]!;
  const lastColon = sourceFull.lastIndexOf(":");
  const source = lastColon !== -1 ? sourceFull.slice(0, lastColon) : sourceFull;
  return { ts: m[1]!, level: m[2]!, source, text: m[4]! };
}

// ---------------------------------------------------------------------------
// Per-page setup — CDP for network logging + source file capture
// ---------------------------------------------------------------------------

export async function setupPageDebug(
  page: Page,
  ctx: BrowserContext,
  session: DebugSession,
): Promise<CDPSession | null> {
  try {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Network.enable");

    setupNetworkLogging(cdp, session);
    setupCookieCapture(cdp, session);
    setupSourceCapture(cdp, session);
    return cdp;
  } catch {
    return null;
  }
}

/** Dump all browser cookies to cookies.jsonl as a final snapshot. */
export async function dumpCookies(cdp: CDPSession, session: DebugSession): Promise<void> {
  try {
    const result = await cdp.send("Network.getAllCookies" as never);
    const cookies = (result as Record<string, unknown>)["cookies"] as Array<Record<string, unknown>>;
    if (cookies) {
      session.log("cookies.jsonl", { event: "snapshot", cookies });
    }
  } catch {
    // Cookie dump not available
  }
}

/**
 * Log network request/response events to network.jsonl via CDP.
 * chrome.log only gives us URLs — CDP gives status codes, headers, timing.
 */
function setupNetworkLogging(cdp: CDPSession, session: DebugSession): void {
  cdp.on("Network.requestWillBeSent", (params: Record<string, unknown>) => {
    const req = params["request"] as Record<string, unknown> | undefined;
    session.log("network.jsonl", {
      event: "request",
      id: params["requestId"],
      url: req?.["url"],
      method: req?.["method"],
      headers: req?.["headers"],
      type: params["type"],
    });
  });

  cdp.on("Network.responseReceived", (params: Record<string, unknown>) => {
    const resp = params["response"] as Record<string, unknown> | undefined;
    session.log("network.jsonl", {
      event: "response",
      id: params["requestId"],
      url: resp?.["url"],
      status: resp?.["status"],
      headers: resp?.["headers"],
      mimeType: resp?.["mimeType"],
    });
  });

  cdp.on("Network.loadingFailed", (params: Record<string, unknown>) => {
    session.log("network.jsonl", {
      event: "failed",
      id: params["requestId"],
      error: params["errorText"],
      type: params["type"],
    });
  });
}

/**
 * Capture cookie activity via CDP.
 * - Network.responseReceivedExtraInfo has raw Set-Cookie headers
 *   (stripped from the regular Network.responseReceived event)
 * - Network.requestWillBeSentExtraInfo has Cookie headers sent with requests
 */
function setupCookieCapture(cdp: CDPSession, session: DebugSession): void {
  cdp.on("Network.responseReceivedExtraInfo", (params: Record<string, unknown>) => {
    const headers = params["headers"] as Record<string, string> | undefined;
    if (!headers) return;
    const setCookie = headers["set-cookie"] || headers["Set-Cookie"];
    if (!setCookie) return;
    session.log("cookies.jsonl", {
      event: "set",
      id: params["requestId"],
      cookies: setCookie,
    });
  });

  cdp.on("Network.requestWillBeSentExtraInfo", (params: Record<string, unknown>) => {
    const headers = params["headers"] as Record<string, string> | undefined;
    if (!headers) return;
    const cookie = headers["cookie"] || headers["Cookie"];
    if (!cookie) return;
    session.log("cookies.jsonl", {
      event: "sent",
      id: params["requestId"],
      cookies: cookie,
    });
  });
}

/**
 * Capture response bodies for JS and HTML resources into sources/.
 * This is the one thing neither chrome.log nor CDP event data provides
 * — we need an explicit Network.getResponseBody call.
 */
function setupSourceCapture(cdp: CDPSession, session: DebugSession): void {
  const pending = new Map<string, string>(); // requestId → url
  let index = 0;

  cdp.on("Network.responseReceived", (params: Record<string, unknown>) => {
    const resp = params["response"] as Record<string, unknown> | undefined;
    const mimeType = resp?.["mimeType"] as string | undefined;
    const url = resp?.["url"] as string | undefined;
    const type = params["type"] as string | undefined;

    if (
      url &&
      (mimeType?.includes("javascript") ||
        mimeType?.includes("ecmascript") ||
        mimeType?.includes("html") ||
        type === "Script" ||
        type === "Document")
    ) {
      pending.set(params["requestId"] as string, url);
    }
  });

  cdp.on("Network.loadingFinished", (params: Record<string, unknown>) => {
    const requestId = params["requestId"] as string;
    const url = pending.get(requestId);
    if (!url) return;
    pending.delete(requestId);

    cdp
      .send("Network.getResponseBody", { requestId } as never)
      .then((result: Record<string, unknown>) => {
        const body = result["body"] as string;
        if (!body) return;
        session.saveSource(sanitizeFilename(index++, url), body);
      })
      .catch(() => {});
  });

  cdp.on("Network.loadingFailed", (params: Record<string, unknown>) => {
    pending.delete(params["requestId"] as string);
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sanitizeFilename(index: number, url: string): string {
  const prefix = String(index).padStart(3, "0");
  try {
    const u = new URL(url);
    let name = u.pathname.slice(1).replace(/\//g, "_") || "index";
    if (u.search) {
      name += `_${u.search.slice(0, 20).replace(/[^a-zA-Z0-9]/g, "")}`;
    }
    if (!name.match(/\.(js|html|htm|json|css|xml)$/)) {
      name += u.pathname.includes(".") ? ".js" : ".html";
    }
    return `${prefix}_${name}`;
  } catch {
    return `${prefix}_unknown.html`;
  }
}
