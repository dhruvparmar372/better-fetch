import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BrowserDomainList } from "@/config.ts";

let tempDir: string;
let filePath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "better-fetch-test-"));
  filePath = join(tempDir, "browser-domains.txt");
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("BrowserDomainList", () => {
  test("starts with seed domains", () => {
    const list = new BrowserDomainList(filePath, ["example.com"]);
    expect(list.has("example.com")).toBe(true);
    expect(list.requiresBrowser("https://example.com/page")).toBe(true);
  });

  test("requiresBrowser returns false for unknown domains", () => {
    const list = new BrowserDomainList(filePath, ["example.com"]);
    expect(list.requiresBrowser("https://other.com/page")).toBe(false);
  });

  test("markDomainAsBrowserOnly adds and persists a new domain", () => {
    const list = new BrowserDomainList(filePath, ["seed.com"]);
    expect(list.requiresBrowser("https://newsite.com/page")).toBe(false);

    list.markDomainAsBrowserOnly("https://newsite.com/page");
    expect(list.requiresBrowser("https://newsite.com/page")).toBe(true);

    // Verify it was written to disk
    const content = readFileSync(filePath, "utf-8");
    expect(content).toContain("newsite.com");
  });

  test("persisted domains survive reload", () => {
    const list1 = new BrowserDomainList(filePath, ["seed.com"]);
    list1.markDomainAsBrowserOnly("https://learned.com/foo");

    // Create a new instance from the same file — simulates server restart
    const list2 = new BrowserDomainList(filePath, ["seed.com"]);
    expect(list2.requiresBrowser("https://learned.com/bar")).toBe(true);
    expect(list2.has("seed.com")).toBe(true);
  });

  test("seed domains are not written to disk", () => {
    const list = new BrowserDomainList(filePath, ["seed.com"]);
    list.markDomainAsBrowserOnly("https://other.com/x");

    const content = readFileSync(filePath, "utf-8");
    expect(content).not.toContain("seed.com");
    expect(content).toContain("other.com");
  });

  test("duplicate markDomainAsBrowserOnly is idempotent", () => {
    const list = new BrowserDomainList(filePath, ["seed.com"]);
    list.markDomainAsBrowserOnly("https://dup.com/a");
    list.markDomainAsBrowserOnly("https://dup.com/b");
    list.markDomainAsBrowserOnly("https://dup.com/c");

    const content = readFileSync(filePath, "utf-8");
    const matches = content.split("\n").filter((l) => l.trim() === "dup.com");
    expect(matches.length).toBe(1);
  });

  test("handles invalid URLs gracefully", () => {
    const list = new BrowserDomainList(filePath, ["seed.com"]);
    expect(list.requiresBrowser("not-a-url")).toBe(false);

    // Should not throw
    list.markDomainAsBrowserOnly("not-a-url");
    expect(list.size).toBe(1); // only seed
  });

  test("works with no file and no seeds", () => {
    const list = new BrowserDomainList(filePath, []);
    expect(list.size).toBe(0);
    expect(list.requiresBrowser("https://anything.com")).toBe(false);
  });

  test("multiple domains accumulate across marks", () => {
    const list = new BrowserDomainList(filePath, []);
    list.markDomainAsBrowserOnly("https://a.com/1");
    list.markDomainAsBrowserOnly("https://b.com/2");
    list.markDomainAsBrowserOnly("https://c.com/3");

    expect(list.size).toBe(3);

    // All persisted
    const list2 = new BrowserDomainList(filePath, []);
    expect(list2.has("a.com")).toBe(true);
    expect(list2.has("b.com")).toBe(true);
    expect(list2.has("c.com")).toBe(true);
  });
});
