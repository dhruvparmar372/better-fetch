# better-fetch

An MCP server that gives AI tools a reliable way to fetch content from the web.

Built for tools like Claude Code, ChatGPT, and any MCP-compatible client — better-fetch handles the messy reality of the modern web so your AI doesn't have to.

## Why

AI tools are bad at reading the web. Pages block bots, return garbage HTML, or hide the actual content behind layers of scripts and ads. better-fetch solves this by acting as a local MCP server that fetches, renders, and extracts meaningful content from any URL.

## Key Features

**Anti-Bot Bypass** — Uses a real browser environment to get past bot detection, CAPTCHAs, and JavaScript-rendered pages that simple HTTP requests can't handle.

**Meaningful Content Extraction** — Strips away navigation, ads, sidebars, and boilerplate to return just the content that matters. Not a raw HTML dump — actual readable content.

**Fully Local** — Runs entirely on your machine. No data leaves your system, no third-party APIs, no cloud dependencies. Your browsing stays yours.

## Status

Under active development.
