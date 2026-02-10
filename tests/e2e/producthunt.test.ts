import { describe, test, expect, afterAll } from "bun:test";
import { createTestRun } from "./harness.ts";

let run: ReturnType<typeof createTestRun>;

afterAll(async () => {
  await run?.done();
}, 15_000);

describe("producthunt", () => {
  test("fetches ProductHunt product page", async () => {
    run = createTestRun("producthunt");
    const html = await run.fetch("https://www.producthunt.com/products/notion");
    expect(html).toContain("Notion");
  }, 180_000);
});
