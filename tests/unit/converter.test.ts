import { describe, test, expect } from "bun:test";
import { convertHtml } from "@/converter.ts";

describe("convertHtml", () => {
  test("converts HTML to markdown", async () => {
    const html = `<!DOCTYPE html><html><head><title>Test Page</title></head><body>
      <article><h1>Hello World</h1><p>Some content here.</p></article>
    </body></html>`;

    const result = await convertHtml(html, "https://example.com/page");

    expect(result.markdown).toContain("Hello World");
    expect(result.markdown).toContain("Some content here.");
    expect(result.title).toBe("Test Page");
  });
});
