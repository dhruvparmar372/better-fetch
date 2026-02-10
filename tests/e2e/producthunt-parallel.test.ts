import { describe, test, expect, afterAll } from "bun:test";
import { createTestRun } from "./harness.ts";

let run: ReturnType<typeof createTestRun>;

afterAll(async () => {
  await run?.done();
}, 15_000);

describe("producthunt parallel", () => {
  test("fetches three pages in parallel", async () => {
    run = createTestRun("producthunt-parallel");
    const [notion, figma, home] = await run.fetchAll([
      "https://www.producthunt.com/products/notion",
      "https://www.producthunt.com/products/figma",
      "https://www.producthunt.com",
    ]);
    expect(notion).toContain("Notion");
    expect(figma).toContain("Figma");
    expect(home).toContain("Product Hunt");
  }, 180_000);
});
