import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

function getStateDir(): string {
  const xdgState = process.env["XDG_STATE_HOME"];
  const base = xdgState || join(homedir(), ".local", "state");
  return join(base, "better-fetch");
}

const SEED_DOMAINS = [
  "producthunt.com",
  "www.producthunt.com",
];

export class BrowserDomainList {
  private domains: Set<string>;

  constructor(
    private readonly filePath: string,
    private readonly seeds: string[] = SEED_DOMAINS,
  ) {
    this.domains = this.load();
  }

  private load(): Set<string> {
    const domains = new Set<string>(this.seeds);
    try {
      const content = readFileSync(this.filePath, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (trimmed) domains.add(trimmed);
      }
    } catch {
      // File doesn't exist yet — use seeds only
    }
    return domains;
  }

  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    // Only persist non-seed domains (seeds are always loaded in code)
    const persisted = [...this.domains].filter((d) => !this.seeds.includes(d));
    writeFileSync(this.filePath, persisted.join("\n") + "\n");
  }

  requiresBrowser(url: string): boolean {
    try {
      const { hostname } = new URL(url);
      return this.domains.has(hostname);
    } catch {
      return false;
    }
  }

  markDomainAsBrowserOnly(url: string): void {
    try {
      const { hostname } = new URL(url);
      if (this.domains.has(hostname)) return;
      this.domains.add(hostname);
      this.save();
    } catch {
      // Invalid URL — ignore
    }
  }

  has(domain: string): boolean {
    return this.domains.has(domain);
  }

  get size(): number {
    return this.domains.size;
  }
}

// Module-level singleton used by the server
const domainList = new BrowserDomainList(
  join(getStateDir(), "browser-domains.txt"),
);

export function requiresBrowser(url: string): boolean {
  return domainList.requiresBrowser(url);
}

export function markDomainAsBrowserOnly(url: string): void {
  domainList.markDomainAsBrowserOnly(url);
}
