# better-fetch

An MCP server that gives AI tools a reliable way to fetch content from the web.

Built for tools like Claude Code, ChatGPT, and any MCP-compatible client — better-fetch handles the messy reality of the modern web so your AI doesn't have to.

## Why

AI tools are bad at reading the web. Pages block bots, return garbage HTML, or hide the actual content behind layers of scripts and ads. better-fetch solves this by acting as a local MCP server that fetches, renders, and extracts meaningful content from any URL.

## How to Use

### Claude Code

**Step 1:** Add better-fetch as an MCP server in your Claude Code configuration (`~/.claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "better-fetch": {
      "command": "bun",
      "args": ["run", "/path/to/better-fetch/src/index.ts"]
    }
  }
}
```

Replace `/path/to/better-fetch` with the actual path where you cloned the repo.

**Step 2:** Claude Code has its own built-in `WebFetch` tool, so it won't automatically prefer better-fetch's `web_fetch` tool. To make Claude use better-fetch for web fetching, add the following to your project's `CLAUDE.md` (or `~/.claude/CLAUDE.md` for global config):

```markdown
When fetching web pages, always use the `web_fetch` MCP tool from better-fetch instead of the built-in WebFetch tool. The better-fetch tool handles anti-bot protection and JavaScript-rendered pages that the built-in tool cannot.
```

Once configured, you can ask Claude to fetch any URL:

```
Fetch the content from https://www.producthunt.com/products/notion
```

### Debug Mode

Debug output is disabled by default. To enable detailed debug logging (network traces, cookies, page HTML, Chrome logs), set:

```bash
BETTER_FETCH_DEBUG=1
```

Debug data is written to the `debug/` directory.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  AI Tool (Claude Code, etc.)                            │
│  "Fetch https://www.producthunt.com/products/notion"    │
└──────────────────────┬──────────────────────────────────┘
                       │ MCP protocol (stdio)
                       ▼
┌─────────────────────────────────────────────────────────┐
│  better-fetch MCP Server                                │
│                                                         │
│  ┌─────────────────────────────────────────────────┐    │
│  │ Tier 1: Plain HTTP fetch()                      │    │
│  │ Fast path for simple sites (example.com, etc.)  │    │
│  │ Uses browser-like headers to look legitimate.   │    │
│  │ If blocked (403/429/503) → falls through.       │    │
│  └──────────────────┬──────────────────────────────┘    │
│                     │ blocked or known anti-bot domain   │
│                     ▼                                    │
│  ┌─────────────────────────────────────────────────┐    │
│  │ Tier 2: Browser Daemon Client                   │    │
│  │ POST /fetch → Unix socket                       │    │
│  │ Spawns daemon if not running, polls /health     │    │
│  └──────────────────┬──────────────────────────────┘    │
│                     │                                    │
│                     ▼                                    │
│  ┌─────────────────────────────────────────────────┐    │
│  │ Content Extraction (defuddle)                   │    │
│  │ Strips clutter (nav, ads, sidebars, footers).   │    │
│  │ Converts cleaned HTML → Markdown.               │    │
│  │ Extracts metadata (title, description, domain). │    │
│  └──────────────────┬──────────────────────────────┘    │
│                     │                                    │
│                     ▼                                    │
│           Return clean Markdown to AI tool               │
└─────────────────────────────────────────────────────────┘
                       │
           Unix socket │ (~/.local/state/better-fetch/browser.sock)
                       ▼
┌─────────────────────────────────────────────────────────┐
│  Browser Daemon (shared, singleton process)             │
│                                                         │
│  Detached process that outlives any single MCP server.  │
│  Shared across all MCP server instances (e.g. multiple  │
│  Claude Code windows).                                  │
│                                                         │
│  ┌─────────────────────────────────────────────────┐    │
│  │ HTTP server on Unix socket                      │    │
│  │  POST /fetch   — fetch a URL in a new tab       │    │
│  │  GET  /health  — status, active/queued tabs     │    │
│  └──────────────────┬──────────────────────────────┘    │
│                     │                                    │
│  ┌─────────────────────────────────────────────────┐    │
│  │ Chrome Instance (lazy-launched on first fetch)  │    │
│  │                                                 │    │
│  │  ┌───────────┐ ┌───────────┐ ┌───────────┐     │    │
│  │  │   Tab 1   │ │   Tab 2   │ │   Tab 3   │     │    │
│  │  │  (fetch)  │ │  (fetch)  │ │  (fetch)  │     │    │
│  │  └───────────┘ └───────────┘ └───────────┘     │    │
│  │         Semaphore: max 10 concurrent tabs       │    │
│  │                                                 │    │
│  │  Challenge detection:                           │    │
│  │  If anti-bot challenge → wait for resolution    │    │
│  └─────────────────────────────────────────────────┘    │
│                                                         │
│  Lifecycle:                                             │
│  • Spawned on first browser-tier fetch                  │
│  • Auto-exits after 5 min idle (no in-flight requests)  │
│  • Graceful shutdown: drains requests, closes Chrome    │
│  • Stale socket/Chrome cleanup on next spawn            │
└─────────────────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│  Chrome (your existing installation)                    │
│                                                         │
│  Launched via Playwright with a FRESH user data dir     │
│  at ~/.local/state/better-fetch/chrome-profile/         │
│                                                         │
│  Your personal Chrome profiles and sessions are         │
│  NEVER touched or accessed.                             │
└─────────────────────────────────────────────────────────┘
```

### Key Decisions

**Why a shared daemon?**

Multiple MCP server instances (e.g. several Claude Code windows) would each launch their own Chrome — wasting memory and fighting over the profile lock. The daemon extracts Chrome management into a single, shared process. Socket binding acts as an atomic lock: only one daemon can own the socket, so parallel spawn attempts resolve cleanly without races.

**Why a real, headful Chrome browser?**

Most anti-bot systems work by fingerprinting the browser environment — checking for headless indicators, automation flags, WebGL rendering, canvas hashes, and dozens of other signals. A real Chrome instance running in headful mode passes all of these checks natively because it *is* a real browser. No amount of header spoofing or headless patching can replicate this reliably.

**Privacy: fresh profile, no access to your data**

better-fetch launches Chrome using your existing Chrome installation but with a completely **separate user data directory** (`~/.local/state/better-fetch/chrome-profile/`). This means:

- It does NOT use any of your authenticated Chrome sessions
- It does NOT have access to your bookmarks, passwords, cookies, or browsing history
- It behaves like a brand-new Chrome installation with a clean slate

**How persistence works**

better-fetch persists two things across restarts:

1. **Cookies (Chrome profile):** When Chrome solves an anti-bot challenge, the resulting cookies are stored in the profile's cookie database at `~/.local/state/better-fetch/chrome-profile/`. Because we use a persistent context (not incognito), these cookies survive across browser restarts — so a challenge only needs to be solved once, and subsequent visits to the same site pass through automatically.

2. **Anti-bot domain list:** better-fetch learns which domains require a browser. On the first fetch to any domain, it tries a plain HTTP request. If that gets blocked (403/429/503) and the browser fallback succeeds, the domain is automatically added to `~/.local/state/better-fetch/browser-domains.txt`. On subsequent fetches to that domain, the server skips the plain HTTP attempt and goes straight to the browser — saving time and avoiding unnecessary blocked requests.

**Concurrency**

Multiple URLs can be fetched in parallel — each gets its own browser tab within the same Chrome instance. A semaphore caps concurrency at 10 simultaneous tabs to avoid overwhelming the browser or triggering rate limits. The daemon exposes active and queued tab counts via its `/health` endpoint.

**Crash recovery and race conditions**

The daemon handles real-world failure scenarios:

- **Parallel spawns (thundering herd):** Socket binding is atomic — one daemon wins, others detect the running instance and exit.
- **Stale sockets:** If the daemon crashes without cleanup, the next client detects the dead socket, removes it, and spawns a fresh daemon.
- **Orphaned Chrome:** On startup, the daemon checks for stale Chrome processes via `SingletonLock` symlinks, verifies the PID is actually Chrome (guarding against PID recycling), and kills orphans before launching.
- **Shutdown overlap:** The old daemon removes its socket immediately on shutdown, allowing a new daemon to bind while the old one drains in-flight requests.

### Limitations

- **IP-based rate limiting:** Some sites use IP-based blocking in addition to browser fingerprinting, sometimes requiring CAPTCHA solving that cannot be automated. Proxy/IP rotation is not yet supported.
- **Headful only:** Chrome runs with a visible window. This is by design for anti-bot bypass but means it requires a display (or virtual display on Linux).

## Status

Under active development.
