# Changelog

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
