# llms-ink

Turn any link — site, docs section, page, GitHub repo, PDF or video — into llms.txt and llms-full.txt. A typed
client for the [llms.ink](https://llms.ink) API with no dependencies. Runs on Node 18+, Bun, Deno, Cloudflare
Workers and browsers. Also a [Vite plugin, an Astro integration and middleware](#serve-llmstxt-from-your-site) that
serve llms.txt from your own site.

```sh
npm install llms-ink        # or: bun add llms-ink
deno add jsr:@lukax/llms-ink   # or: npx jsr add @lukax/llms-ink
```

```ts
import { LlmsInk } from 'llms-ink'; // Deno/JSR: from 'jsr:@lukax/llms-ink'

const ink = new LlmsInk();

const index = await ink.llms('developers.cloudflare.com/kv/');            // llms.txt: an index of links
const full = await ink.llms('github.com/honojs/hono', { mode: 'full' });  // llms-full.txt: the content
console.log(full.title, full.tokens, full.text);

const report = await ink.check('llmstxt.org'); // is a site's own llms.txt valid, do its links answer?
console.log(report.found, report.summary, report.issues);
```

## API

### `new LlmsInk({ key?, baseUrl?, fetch? })`

- `key`: an API key (`lk_…`), sent as `Authorization: Bearer`. Defaults to the `LLMS_INK_KEY` environment
  variable where there is one (Node, Bun, Deno with `--allow-env`). Without a key, requests are anonymous and
  share the free limits. An invalid or revoked key throws `InvalidKeyError`; it never falls back to anonymous.
- `baseUrl`: defaults to `LLMS_INK_API`, else `https://llms.ink`.
- `fetch`: a `fetch` to use instead of the global one.

### `ink.llms(url, { mode?, fresh?, native?, signal? })` → `Promise<Result>`

`mode` is `'llms'` (default) or `'full'` (up to 20 pages inlined). `fresh: true` skips the cache and rebuilds
(counts against the daily quota). `native: false` always generates the file and never returns the site's own
llms.txt (by default a site's own file is returned as is, unless llms.ink generated it). The result:

```ts
{ url, kind, source, mode, title, text, tokens, pages, model, cached, generatedAt, media? }
```

`kind` is `site | section | page | repo | document | video`; `source` is `native` (the site publishes it) or
`generated`. `media` is set for videos (duration, thumbnail, downloads, transcript segments).

Building a big site or a video can take minutes. Bound a call with a signal:
`ink.llms(url, { signal: AbortSignal.timeout(120_000) })`. Aborts are rethrown as is.

### `ink.check(url, { signal? })` → `Promise<CheckResult>`

Checks the site's (or docs section's) published llms.txt against the llmstxt.org format and fetches its first
25 links: `{ site, url, found, status, title, tokens, sections, links, llmsFull, parsed, issues, summary, checkedAt }`.

`parsed` is the file's structure (`null` when nothing was found):

```ts
{ title, summary, details, sections: [{ name, optional, text, links: [{ title, url, notes, line }] }] }
```

### `ink.checkText(text, { base?, links?, signal? })` → `Promise<CheckResult>`

Parses and checks llms.txt text you already have, e.g. before publishing it:

```ts
const { parsed, issues } = await ink.checkText(await readFile('public/llms.txt', 'utf8'), {
  base: 'https://example.com/llms.txt', // resolves relative links; reported as url/site
  links: true,                          // also fetch up to 25 links and look for llms-full.txt
});
```

Without `base`, `site` and `url` are `null`; without `base` and `links`, `llmsFull` is `null` and
`links.checked` is 0. Up to 2 MB.

### `ink.markdown(html, { url?, signal? })` → `Promise<string>`

A page's HTML as Markdown, the way llms.ink reads pages: hidden-instruction text (comments, hidden elements,
off-screen text addressed to AI), scripts, navigation, headers, footers and forms are dropped first. `url` (never
fetched) resolves relative links. Up to 5 MB; nothing is stored.

```ts
const md = await ink.markdown(await readFile('dist/pricing/index.html', 'utf8'), { url: 'https://example.com/pricing/' });
```

### `ink.stream(url, { mode?, fresh?, signal? })` → `AsyncGenerator<StreamEvent>`

The same build as `llms()`, as it happens:

```ts
for await (const event of ink.stream('docs.astro.build', { mode: 'full' })) {
  if (event.type === 'progress') console.log(event.stage, event.detail);
  if (event.type === 'partial') preview(event.text); // incomplete so far
  if (event.type === 'result') save(event.result);   // always last
}
```

Breaking out of the loop cancels the request.

## Serve llms.txt from your site

### Vite: `llms-ink/vite`

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { llmsInk } from 'llms-ink/vite';

export default defineConfig({ plugins: [llmsInk({ site: 'https://example.com', full: true })] });
```

After `vite build` (not the dev server or SSR builds), writes `llms.txt` (and `llms-full.txt` with `full`) for
`site` into `build.outDir`. llms.ink reads the live site, so the files describe the previous deploy. If llms.ink
fails, the plugin warns and keeps any existing file (e.g. one from `public/`); `strict: true` fails the build.
Options: `site`, `full`, `key` (default `LLMS_INK_KEY`), `native` (default `true`; a file llms.ink generated before
is regenerated, not echoed), `strict`, `timeout` (ms, default 300000), `baseUrl`, `markdownPages`.

`markdownPages: true` also writes a Markdown version next to every HTML page of this build (`about.html` →
`about.md`, `docs/index.html` → `docs/index.md`), converted with `ink.markdown()` from the local output, so the
`.md` pages match what you're deploying. Existing `.md` files are kept; `/404`, `/500` and pages over 5 MB are
skipped; a rate limit is waited out (`Retry-After`). Failures warn and the build goes on, unless `strict`. Pass
`{ concurrency, exclude }` (default 4 at a time; `exclude` is a RegExp on the page path) to tune it. Large sites:
use an API key (60 conversions a minute anonymous per IP, the key's own limit otherwise). They're static files:
`/about.md` works as is; for `Accept: text/markdown` on the page URL, add a rewrite to `<page>.md` on your host.

### Astro: `llms-ink/astro`

```ts
// astro.config.mjs
import { defineConfig } from 'astro/config';
import llmsInk from 'llms-ink/astro';

export default defineConfig({ site: 'https://example.com', integrations: [llmsInk({ full: true })] });
```

The same, on `astro:build:done`, into the static output. `site` defaults to Astro's `site` plus `base`.

### Middleware: `llms-ink/middleware`

```ts
import { llmsInkHandler, llmsInkExpress } from 'llms-ink/middleware';

const llms = llmsInkHandler({ site: 'https://example.com', markdown: true });
const response = (await llms(request)) ?? (await app(request)); // Workers, Next.js proxy, Deno, Bun, Hono

expressApp.use(llmsInkExpress({ site: 'https://example.com' })); // Express, Connect
```

Answers `GET`/`HEAD` `/llms.txt` and `/llms-full.txt` from llms.ink, always generated (`native=0`, so it can't
loop through itself), with llms.ink's `Cache-Control`. Each answer is kept in memory for its `max-age` and served as
a last good copy (`Warning: 110`, `Cache-Control: max-age=60`) when llms.ink fails. With `markdown: true` it also
answers `/<page>.md` and requests whose `Accept` prefers `text/markdown` over `text/html` with the page as Markdown.
Everything else, and llms.ink's own fetcher, gets `undefined` (Express: `next()`). Options: `site`, `key` (default
`LLMS_INK_KEY`; recommended on shared hosting IPs), `markdown`, `baseUrl`. Don't also ship a static `llms.txt`:
most hosts serve it before the middleware runs.

#### AI traffic

```ts
const llms = llmsInkHandler({ site: 'https://example.com', traffic: { key: env.LLMS_INK_KEY } });
const response = (await llms(request, ctx)) ?? (await app(request)); // Workers: ctx; Next.js proxy: the event

expressApp.use(llmsInkExpress({ site: 'https://example.com', traffic: { key: process.env.LLMS_INK_KEY } }));
```

With `traffic: { key, site?, flushEvery? }` the middleware also counts requests from AI agents (`AI_AGENTS`):
user fetches (`ChatGPT-User`, `Claude-User`, `Perplexity-User`…, someone asked an assistant) and crawlers (`GPTBot`,
`OAI-SearchBot`, `ClaudeBot`, `PerplexityBot`, `Googlebot`, `bingbot`…). It counts every request it sees, served or
not, per path and agent in memory, and every `flushEvery` seconds (default 60, at least 10) sends the day's totals to
`POST /api/v0/traffic`, at most 1000 rows per request. Only `{ site, period, rows: [{ path, agent, kind, count }] }`
leaves your server: no IPs, user agents, query strings or cookies; browsers aren't counted. Sends never block a
response: with `ctx` they go to `ctx.waitUntil`, without one (Node, Bun, Deno) an unref'd timer sends. Failed sends
keep their counts and retry with backoff (honoring `Retry-After`); a `401` or `403 site_claimed` stops counting with
one warning. `site` defaults to the middleware's hostname; the first key to send for a site owns it. Counts not yet
sent are lost when the process stops: call `await llms.flush()` on shutdown. Read them at
[llms.ink/traffic](https://llms.ink/traffic/) or `GET /api/v0/traffic?site=&days=` with the same key.
`classifyAgent(userAgent)` and `trafficCounter({ key, site })` (`record(request, ctx?)`, `flush()`) are exported for
other servers.

## Errors

Every failure is an `LlmsInkError` with `status`, `code`, `title`, `detail`, `errors` (per-parameter issues of
`invalid_request`) and `retryAfter` (seconds, from `Retry-After`). When llms.ink can't be reached, `status` and
`code` are undefined and `cause` holds the network error. Codes are listed at
[llms.ink/docs](https://llms.ink/docs/#errors).

| Class | Status | Code | When |
|---|---|---|---|
| `InvalidKeyError` | 401 | `invalid_key` | The key is malformed, unknown or revoked. |
| `RateLimitedError` | 429 | `rate_limited` | Too many requests this minute; wait `retryAfter` seconds. |
| `QuotaExceededError` | 429 | `quota_exceeded` | Daily quota of new links used up; `retryAfter` is the seconds until midnight UTC. Cached links still work. |

```ts
import { LlmsInk, RateLimitedError } from 'llms-ink';

try {
  await ink.llms('example.com');
} catch (err) {
  if (err instanceof RateLimitedError) await new Promise((r) => setTimeout(r, err.retryAfter! * 1000));
  else throw err;
}
```

## Limits

Anonymous: 10 requests a minute per IP, 60 new (uncached) links a day per IP. Cached results are free. A key
gets its own daily quota (1000 new links by default) and 60 requests a minute;
[ask for one](https://lucasespindola.com/message?text=Hi+Lucas%2C+I%E2%80%99d+like+an+llms.ink+API+key+for+...).

## License

MIT
