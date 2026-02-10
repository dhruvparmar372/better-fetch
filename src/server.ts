import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fetchUrl, FetchBlockedError } from "@/fetcher.ts";
import { fetchWithBrowser } from "@/browser.ts";
import { requiresBrowser, markDomainAsBrowserOnly } from "@/config.ts";
import { convertHtml, type ConvertResult } from "@/converter.ts";

function formatResponse(result: ConvertResult): string {
  const parts: string[] = [];
  if (result.title) parts.push(`# ${result.title}`);
  if (result.description) parts.push(`> ${result.description}`);
  if (parts.length > 0) parts.push("---");
  parts.push(result.markdown);
  return parts.join("\n\n");
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: "better-fetch",
    version: "0.1.0",
  });

  server.registerTool("web_fetch", {
    description: "Fetch a URL and return its content as clean Markdown",
    inputSchema: z.object({
      url: z.string().url(),
    }),
  }, async ({ url }) => {
    // Skip fetch() entirely for domains with known anti-bot protection
    let fellThrough = false;
    if (!requiresBrowser(url)) {
      try {
        const html = await fetchUrl(url);
        const converted = await convertHtml(html, url);
        return {
          content: [{ type: "text" as const, text: formatResponse(converted) }],
        };
      } catch (err) {
        if (!(err instanceof FetchBlockedError)) throw err;
        fellThrough = true;
        // Fall through to browser
      }
    }

    const html = await fetchWithBrowser(url);

    // If plain fetch was blocked but browser succeeded, remember this domain
    if (fellThrough) {
      markDomainAsBrowserOnly(url);
    }

    const converted = await convertHtml(html, url);
    return {
      content: [{ type: "text" as const, text: formatResponse(converted) }],
    };
  });

  return server;
}
