import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setDebugBaseDir, resetDebugBaseDir } from "@/debug.ts";
import { fetchWithBrowser, closeBrowser } from "@/browser.ts";

// Same signatures as browser.ts
const CHALLENGE_SIGNATURES = [
  "captcha-delivery.com",
  "challenge-platform",
  "cf-challenge",
  "/cdn-cgi/challenge-platform",
];

function detectChallenge(html: string): boolean {
  const lower = html.toLowerCase();
  return CHALLENGE_SIGNATURES.some((sig) => lower.includes(sig));
}

interface StepResult {
  step: number;
  url: string;
  passed: boolean;
  durationMs: number;
  challengeDetected: boolean;
  error?: string;
}

class TestRun {
  readonly runDir: string;
  readonly results: StepResult[] = [];
  private step = 0;

  constructor(name: string) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    this.runDir = join(process.cwd(), "debug", name, ts);
    mkdirSync(this.runDir, { recursive: true });
    setDebugBaseDir(this.runDir);
  }

  async fetch(url: string): Promise<string> {
    const start = Date.now();
    const stepNum = this.step++;
    let html: string;
    let passed = false;
    let challengeDetected = false;

    let error: string | undefined;

    try {
      html = await fetchWithBrowser(url);
      challengeDetected = detectChallenge(html);
      passed = !challengeDetected;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      html = "";
      passed = false;
    }

    this.results.push({
      step: stepNum,
      url,
      passed,
      durationMs: Date.now() - start,
      challengeDetected,
      error,
    });

    if (error) throw new Error(`fetch failed for ${url}: ${error}`);

    return html;
  }

  async fetchAll(urls: string[]): Promise<string[]> {
    return Promise.all(urls.map((u) => this.fetch(u)));
  }

  async sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  async done(): Promise<void> {
    writeFileSync(
      join(this.runDir, "results.json"),
      JSON.stringify(
        { finishedAt: new Date().toISOString(), steps: this.results },
        null,
        2,
      ),
    );
    await closeBrowser();
    resetDebugBaseDir();
  }
}

export function createTestRun(name: string): TestRun {
  return new TestRun(name);
}
