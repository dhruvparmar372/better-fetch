const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
  "Sec-Ch-Ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"macOS"',
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
};

export class FetchBlockedError extends Error {
  status: number;
  constructor(status: number, statusText: string) {
    super(`Fetch blocked: ${status} ${statusText}`);
    this.name = "FetchBlockedError";
    this.status = status;
  }
}

const BLOCKED_STATUS_CODES = new Set([403, 429, 503]);

export async function fetchUrl(url: string): Promise<string> {
  const response = await fetch(url, { headers: BROWSER_HEADERS });
  if (BLOCKED_STATUS_CODES.has(response.status)) {
    throw new FetchBlockedError(response.status, response.statusText);
  }
  if (!response.ok) {
    throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
  }
  return response.text();
}
