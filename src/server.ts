import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fetchUrl, FetchBlockedError } from "./fetcher.ts";
import { fetchWithBrowser } from "./browser.ts";
import { requiresBrowser, markDomainAsBrowserOnly } from "./config.ts";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "better-fetch",
    version: "0.1.0",
  });

  server.registerTool("web_fetch", {
    description: "Fetch a URL and return its content as text",
    inputSchema: z.object({
      url: z.string().url(),
    }),
  }, async ({ url }) => {
    // Skip fetch() entirely for domains with known anti-bot protection
    let fellThrough = false;
    if (!requiresBrowser(url)) {
      try {
        const text = await fetchUrl(url);
        return {
          content: [{ type: "text" as const, text }],
        };
      } catch (err) {
        if (!(err instanceof FetchBlockedError)) throw err;
        fellThrough = true;
        // Fall through to browser
      }
    }

    const text = await fetchWithBrowser(url);

    // If plain fetch was blocked but browser succeeded, remember this domain
    if (fellThrough) {
      markDomainAsBrowserOnly(url);
    }

    return {
      content: [{ type: "text" as const, text }],
    };
  });

  return server;
}
