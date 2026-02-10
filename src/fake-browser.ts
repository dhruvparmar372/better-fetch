/**
 * Fake browser implementation for testing.
 *
 * Replaces Playwright's BrowserContext/Page with lightweight fakes that:
 * - Actually fetch URLs via HTTP (so slow test servers still cause delays)
 * - Create/remove SingletonLock (so orphan cleanup tests work)
 * - Simulate configurable launch delay (so SIGTERM-during-launch tests work)
 *
 * Activated by setting BETTER_FETCH_FAKE_BROWSER=1 in the daemon's environment.
 */
import { existsSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";

type EventHandler = (...args: unknown[]) => void;

class FakePage {
  private html = "";
  private pageTitle = "";

  async goto(url: string, _options?: unknown): Promise<void> {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    this.html = await res.text();
    const match = this.html.match(/<title[^>]*>(.*?)<\/title>/i);
    this.pageTitle = match?.[1] ?? "";
  }

  async title(): Promise<string> {
    return this.pageTitle;
  }

  async content(): Promise<string> {
    return this.html;
  }

  async waitForLoadState(_state?: string, _options?: unknown): Promise<void> {
    // No-op
  }

  async close(): Promise<void> {
    // No-op
  }
}

export class FakeBrowserContext {
  private handlers = new Map<string, EventHandler[]>();
  private lockPath: string;

  constructor(lockPath: string) {
    this.lockPath = lockPath;
  }

  async newPage(): Promise<FakePage> {
    return new FakePage();
  }

  on(event: string, handler: EventHandler): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  async close(): Promise<void> {
    // Remove SingletonLock like real Chrome does on exit
    try { unlinkSync(this.lockPath); } catch {}

    const handlers = this.handlers.get("close") ?? [];
    for (const h of handlers) h();
  }
}

export async function launchFakeContext(profileDir: string): Promise<FakeBrowserContext> {
  const lockPath = join(profileDir, "SingletonLock");

  // Create SingletonLock early (like real Chrome), before the startup delay.
  // Points to daemon PID — cleanStaleChrome will see it's not Chrome and just
  // remove the file rather than trying to kill the process.
  if (!existsSync(lockPath)) {
    try {
      symlinkSync(`${hostname()}-${process.pid}`, lockPath);
    } catch {
      // Race with another process — fine
    }
  }

  // Simulate Chrome startup delay
  const delayMs = Number(process.env["BETTER_FETCH_FAKE_LAUNCH_DELAY_MS"]) || 500;
  await new Promise((r) => setTimeout(r, delayMs));

  return new FakeBrowserContext(lockPath);
}
