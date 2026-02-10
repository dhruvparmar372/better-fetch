import { describe, test, expect } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/server.ts";

describe("web_fetch tool", () => {
  test("fetches https://example.com and returns content containing 'Example Domain'", async () => {
    const server = createServer();
    const client = new Client({ name: "test-client", version: "0.1.0" });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const result = await client.callTool({
      name: "web_fetch",
      arguments: { url: "https://example.com/" },
    });

    expect(result.content).toBeArray();

    const textContent = (result.content as Array<{ type: string; text: string }>).find(
      (c) => c.type === "text"
    );
    expect(textContent).toBeDefined();
    expect(textContent!.text).toContain("Example Domain");
  });
});
