# Changelog

## 0.6.0

- `llms-ink/ai`: `llmsInkTools({ client?, maxChars?, include? })`, Vercel AI SDK tools (`llmsTxt`, `llmsFullTxt`,
  `checkLlmsTxt`, `agentView`) built with `tool()` and zod `inputSchema` for `generateText`, `streamText` and agents.
  Text is cut to `maxChars` (default 40000) with a note and `truncated: true`; API errors return
  `{ error, code?, retryAfter? }` for the model instead of throwing; an invalid key throws. `ai` (5 and later) and
  `zod` are optional peer dependencies. The README shows connecting https://llms.ink/mcp with the AI SDK's MCP client.
- `ink.report(url, { signal? })`: how AI crawlers and agents see a page (`GET /api/v0/report`), typed as
  `ReportResult`.

## 0.5.0 — 2026-11-14

- Explicit hosted `inspect(text)` with immutable, digest-bound receipts and pilot revision validation.
- Flagged and incomplete scans remain `withhold`; malformed receipts fail closed.
- Required key, encoded request/response limits, redirect refusal and no automatic retries.
- No changes to default retrieval, loaders or local guard behavior.

## 0.4.0 — 2026-11-14

- `ink.markdown(html, { url?, signal? })`: a page's HTML as Markdown (`POST /api/v0/markdown`): hidden-instruction
  text, scripts, navigation, headers and footers dropped; relative links resolved against `url`.
- `llms-ink/vite` and `llms-ink/astro`: `markdownPages: true | { concurrency?, exclude? }` writes a Markdown version
  next to every HTML page of the build (`about.html` → `about.md`, `docs/index.html` → `docs/index.md`), converted
  from the local output. Existing `.md` files are kept, pages over 5 MB and `/404`, `/500` are skipped, a `429` is
  retried after `Retry-After`; failures warn (or fail the build with `strict`). `site` is optional with only
  `markdownPages` (links then stay relative).
- `ErrorCode` includes `too_large` and `unsupported_media_type` (413/415 of the POST endpoints).
- `llms-ink/middleware`: `traffic: { key, site?, flushEvery? }` counts AI-agent requests (user fetches vs crawlers,
  `AI_AGENTS`) per path and sends daily aggregates to `POST /api/v0/traffic` in the background (no IPs, user agents
  or query strings), with batching and backoff. The handler takes an optional `ctx` (`waitUntil`) and both adapters
  have `flush()`. Also exported: `classifyAgent`, `trafficCounter`. `ErrorCode` includes `key_required` and
  `site_claimed`.

## 0.3.0 — 2026-11-14

- `ink.checkText(text, { base?, links?, signal? })`: parses and checks llms.txt text (`POST /api/v0/check`).
- `CheckResult.parsed` (`ParsedLlms`, `ParsedSection`, `ParsedLink` types): the file's title, summary, details and
  sections with their links, from both `check` and `checkText`.
- `CheckResult.site` and `url` are `string | null`, `llmsFull` is `boolean | null` (null when not checked).

## 0.2.0 — 2026-11-14

- `llms-ink/vite`: Vite plugin `llmsInk({ site, full?, key?, native?, strict?, timeout? })` that writes llms.txt
  (and llms-full.txt) into the build output after `vite build`. Warns and keeps any existing file when llms.ink
  fails; `strict: true` fails the build.
- `llms-ink/astro`: Astro integration doing the same on `astro:build:done`; `site` defaults to Astro's `site` + `base`.
- `llms-ink/middleware`: `llmsInkHandler({ site, key?, markdown? })`, a fetch-API handler serving `/llms.txt` and
  `/llms-full.txt` from llms.ink (`native=0&format=text`) with its cache headers, an in-memory copy for `max-age` and
  a stale copy (`Warning: 110`) when llms.ink fails; with `markdown: true`, `/<page>.md` and `Accept: text/markdown`
  requests as Markdown. Never answers llms.ink's own fetcher. `llmsInkExpress(opts)` for Express/Connect.
- `ink.llms(url, { native: false })` sends `native=0`: always generate, never the site's own llms.txt.
- `ErrorCode` includes `loop_detected` (508).
- vite and astro are optional peer dependencies (types only); still no runtime dependencies.

## 0.1.0 — 2026-11-14

- `LlmsInk.llms(url, { mode, fresh, signal })` and `LlmsInk.check(url)` for the llms.ink JSON API, typed after
  the API's schemas. No dependencies; global `fetch` (Node 18+, Bun, Deno, Cloudflare Workers, browsers).
- `LlmsInk.stream(url, opts)`: the build's NDJSON progress, partial text and result as an async iterator.
- Optional API key from `key` or `LLMS_INK_KEY`, sent as `Authorization: Bearer`.
- Typed errors from problem details: `InvalidKeyError`, `RateLimitedError`, `QuotaExceededError` (with
  `retryAfter`), `LlmsInkError`.
- Published to npm as `llms-ink` and to JSR as `@lukax/llms-ink`.
