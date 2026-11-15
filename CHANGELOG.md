# Changelog

## 0.8.2 — 2026-11-15

- Show SDK tool responses and tool errors in the interactive terminal example, separately from Claude prose. Display the tool-use identifier and complete returned content; a response is not proof of an external effect.
- Prefix every model prose line and escape carriage returns and directional controls so returned text cannot overwrite terminal labels. Keep existing explicit approval and cleanup behavior.
- Exercise the actual shipped terminal entry point through a pseudo-terminal: responses, denials, prose-only turns, control characters, approval/decline, interruption and noninteractive refusal. The host API and Python requirement are unchanged.

## 0.8.1 — 2026-11-15

- Publish the host lifetime binding below with the exported SDK `VERSION`, npm metadata and JSR metadata aligned. The failed 0.8.0 tag remains unchanged.

## 0.8.0 — not published

The tag failed its existing exported-version check before publication. Its implementation is included in 0.8.1.

- Require Python Guard 0.14.0+ for the optional Claude adapter. Create a host-bound session and confirm its owner watcher before starting Claude; older services are refused without an unbound fallback.
- End session authority on observed host/watcher disconnection, including abrupt host termination. Keep fixed expiry, per-call review and non-resumable conversations; stopped processes can delay disconnect observation until expiry.
- Report `host_watch_failed` and `host_watch_cleanup_failed` without raw subprocess text. A subsequent run on a closing conversation still surfaces unconfirmed revocation and recovery metadata.
- Add real-process termination and malformed-startup tests. The base SDK and hosted receipt contract remain unchanged.

## 0.7.2 — 2026-11-15

- Handle Claude subscription rate-status events arriving before initialization. Early status is discarded; session identity, guard connection and tool inventory must still pass before use.
- Refuse approval callbacks before initialization. Added service-backed regression cases for early status, premature output/results, mismatched identity, missing initialization and deadline cleanup.
- The observed `rate_limit_event` ordering reproduces one startup failure. Earlier failures without message-order evidence remain unclassified. No automatic action retry or permission expansion.

## 0.7.1 — 2026-11-14

- Fixed failure codes distinguish local service checks, host connection/inventory/identity, stream termination, host-reported limits, output callbacks, deadlines and session expiry without copying raw host errors.
- Cleanup failures preserve the original operation code and recovery credentials. The terminal example reports both codes; unknown provider messages remain private.
- Expanded real-service failure tests verify revocation, no dispatch and sanitized diagnostics. Permissions, inspection and approval requirements are unchanged. The earlier unclassified live-host failure remains unresolved; these diagnostics do not retroactively identify its cause.

## 0.7.0 — 2026-11-14

- Optional Node/POSIX `llms-ink/guard/claude` host adapter: one authenticated local Guard session per non-resumable Claude SDK conversation, shared across sequential turns and revoked on close.
- Explicit application review callbacks, bounded review/turn/session lifetimes, strict guarded tool scope, cancellation and recoverable cleanup failures. Includes an interactive terminal example.
- Service-backed lifecycle tests and an opt-in real Claude SDK/local-model test. Requires Python Guard 0.10.0; the base client and hosted receipt contract are unchanged.

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
