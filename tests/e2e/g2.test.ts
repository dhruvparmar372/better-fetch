import { describe, test, expect, afterAll } from "bun:test";
import { createTestRun } from "@tests/e2e/harness.ts";

let run: ReturnType<typeof createTestRun>;

afterAll(async () => {
  await run?.done();
}, 15_000);

describe("g2", () => {
  test("fetches G2 product page", async () => {
    run = createTestRun("g2");
    const html = await run.fetch("https://www.g2.com/products/supergrow");
    expect(html).toContain("Supergrow");
  }, 180_000);
});
