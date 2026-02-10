import { describe, test, expect, afterAll } from "bun:test";
import { createTestRun } from "./harness.ts";

let run: ReturnType<typeof createTestRun>;

afterAll(async () => {
  await run?.done();
}, 15_000);

describe("producthunt full", () => {
  test("fetches 12 pages in parallel", async () => {
    run = createTestRun("producthunt-full");
    const [
      notion, figma, home,
      engineering, llms, newsletters,
      tinkerer, hunter, claw,
      gravity, predictleads, makers,
    ] = await run.fetchAll([
      "https://www.producthunt.com/products/notion",
      "https://www.producthunt.com/products/figma",
      "https://www.producthunt.com",
      "https://www.producthunt.com/categories/engineering-development",
      "https://www.producthunt.com/categories/llms",
      "https://www.producthunt.com/newsletters",
      "https://www.producthunt.com/products/tinkerer-club-own-everything",
      "https://www.producthunt.com/products/hunter",
      "https://www.producthunt.com/products/claw-fm",
      "https://www.producthunt.com/products/gravity-notes-for-mac",
      "https://www.producthunt.com/products/predictleads-technographics-dataset",
      "https://www.producthunt.com/products/makers-page",
    ]);
    expect(notion).toContain("Notion");
    expect(figma).toContain("Figma");
    expect(home).toContain("Product Hunt");
    expect(engineering).toContain("Engineering");
    expect(llms).toContain("LLM");
    expect(newsletters).toContain("Newsletter");
    expect(tinkerer).toContain("Tinkerer");
    expect(hunter).toContain("Hunter");
    expect(claw).toContain("Claw");
    expect(gravity).toContain("Gravity");
    expect(predictleads).toContain("PredictLeads");
    expect(makers).toContain("Makers");
  }, 300_000);
});
