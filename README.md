# llms-ink

Turn any link — site, docs section, page, GitHub repo, PDF or video — into llms.txt and llms-full.txt. A typed
client for the [llms.ink](https://llms.ink) API with no dependencies. Runs on Node 18+, Bun, Deno, Cloudflare
Workers and browsers. Also a [Vite plugin, an Astro integration and middleware](#serve-llmstxt-from-your-site) that
serve llms.txt from your own site, and [tools for the Vercel AI SDK](#vercel-ai-sdk-llms-inkai).

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

### `ink.report(url, { signal? })` → `Promise<ReportResult>`

How AI crawlers and agents see a page (`GET /api/v0/report`): robots.txt per AI bot, firewall blocks, text without
JavaScript, what survives Markdown conversion, hidden instructions and agent files. `{ url, site, checkedAt,
summary: { pass, warn, fail, info }, sections: [{ id, title, checks: [{ id, status, title, detail, evidence?, fix? }] }] }`;
a `fix` has `kind`, `summary` and, when possible, a `patch: { file, content }`.

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

## Vercel AI SDK: `llms-ink/ai`

```sh
npm install llms-ink ai zod
```

```ts
import { generateText, stepCountIs } from 'ai';
import { llmsInkTools } from 'llms-ink/ai';

const { text } = await generateText({
  model: 'openai/gpt-5',
  tools: llmsInkTools(),
  stopWhen: stepCountIs(5),
  prompt: 'How do I paginate with the Stripe API? Read docs.stripe.com first.',
});
```

`llmsInkTools({ client?, maxChars?, include? })` returns AI SDK tools (`tool()` with zod `inputSchema`, AI SDK 5 and
later; tested with 7) for `generateText`, `streamText` and agents:

| Tool | Input | Returns |
|---|---|---|
| `llmsTxt` | `url`, `fresh?` | `{ url, title, kind, source, tokens, pages, cached, text, truncated }`: the llms.txt index |
| `llmsFullTxt` | `url`, `fresh?` | The same with llms-full.txt: up to 20 pages inlined, or a video's transcript |
| `checkLlmsTxt` | `url`, or `text` with `base?`, `links?` | `{ url, site, found, summary, text, truncated }`: each issue with its line |
| `agentView` | `url` | `{ url, site, summary, text, truncated }`: every check of `ink.report()` with its fix |

- `client`: an `LlmsInk`, or its options (`{ key, baseUrl, fetch }`; `key` defaults to `LLMS_INK_KEY`).
- `maxChars`: longest `text` a tool returns (default 40000). Longer text is cut at a line break and ends with
  `[Truncated: showing N of M characters. …]`, with `truncated: true`.
- `include`: only these tools, e.g. `llmsInkTools({ include: ['llmsTxt', 'checkLlmsTxt'] })`. The return type
  narrows to them.

API errors don't throw: the tool returns `{ error, code?, retryAfter? }` for the model to read, e.g.
`{ error: 'llms.ink rate limit: wait 42 seconds, then try again.', code: 'rate_limited', retryAfter: 42 }`.
An invalid API key (`InvalidKeyError`) and aborts (`abortSignal`) throw.

### Or connect the MCP server

The AI SDK also takes tools from an MCP client. https://llms.ink/mcp gives the same tools plus `video_frame`,
`create_clip_link` and `generate_draft`, with snake_case names (`llms_txt`, `llms_full_txt`…) and text results:

```ts
import { createMCPClient } from '@ai-sdk/mcp'; // AI SDK 5: @ai-sdk/mcp@ai-v5, as experimental_createMCPClient

const mcp = await createMCPClient({
  transport: { type: 'http', url: 'https://llms.ink/mcp', headers: { authorization: `Bearer ${process.env.LLMS_INK_KEY}` } },
});
try {
  const { text } = await generateText({ model: 'openai/gpt-5', tools: await mcp.tools(), stopWhen: stepCountIs(5), prompt });
} finally {
  await mcp.close();
}
```

Leave out `headers` to use it anonymously. `llms-ink/ai` needs no extra package or connection and returns
structured results cut to `maxChars`.

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

## Hosted Inspect (experimental, 0.5.0)

```ts
// Server-side; requires llms-ink >=0.5.0.
import { LlmsInk } from 'llms-ink';

const ink = new LlmsInk({ key: process.env.LLMS_INK_INSPECT_KEY });
const receipt = await ink.inspect('Install the package and read the documentation.');
if (receipt.recommendation !== 'continue') {
  throw new Error(`Withhold content: ${receipt.detection}`);
}
console.log(receipt.contentDigest);
```

Requires an inspection-enabled pilot key. This call uploads only the supplied text to llms.ink; existing retrieval calls, loaders, plugins and the local guard do not opt in automatically. Keep the key server-side.

The client checks the exact UTF-8 SHA-256 digest, model/policy/preprocessing revisions, coverage and token counts before returning an immutable receipt. A flagged result can use HTTP 200; incomplete 422/503 receipts return `unknown`. HTTP problems and invalid receipts raise an error. Withhold on either `withhold` or any exception. `no_finding` is not a safety guarantee, and receipts are unsigned.

Requests are limited to 128 KiB after JSON encoding and responses to 16 KiB. There are no automatic retries: admitted attempts consume pilot allowance even when incomplete. Redirects are refused. Inspection ignores `LLMS_INK_API`; an explicit client base URL may select an HTTPS endpoint or localhost for development. The key follows that explicitly configured endpoint.

For JSON, serialize it yourself and pass the resulting string to `inspect()`. The SDK sends `format: "text"`, so its digest covers those exact bytes; it does not promise cross-language JSON canonicalization. See [pilot limits and privacy](https://llms.ink/inspect/).

JavaScript uses a 65-second total request deadline; pass `{ signal }` to cancel earlier.

## Claude conversation guard (experimental, Node / POSIX)

`llms-ink/guard/claude` binds one Claude Agent SDK conversation to one authenticated local Guard session. Install the optional peer separately:

```sh
npm install llms-ink@0.7.2 @anthropic-ai/claude-agent-sdk@0.3.319
```

First [start the Python 0.10.0 local service](https://llms.ink/guard/service/) with a reviewed gateway configuration and existing Claude authentication. Then try the bundled terminal host:

```sh
node node_modules/llms-ink/examples/guard-claude.mjs \
  --owner-file /private/guard/owner.json \
  --python /absolute/path/to/.venv/bin/python \
  --cwd /absolute/path/to/workspace
```

It requires an interactive terminal and displays the complete review for each permitted action. Type `approve` to send that call once; Enter declines. `/exit`, terminal close and handled termination revoke the session. The example escapes terminal control characters rather than interpreting them. `--model` and `--claude-executable` are optional.

For application hosts, import `createGuardedClaude` and pass absolute `ownerFile`, `python` and `cwd` paths plus `review: async ({message, signal}) => boolean`. Render `message` completely as plain text; abort the UI on `signal`. Only a fresh literal `true` accepts. The returned object exposes the non-secret `sessionId`, sequential `run(prompt, onMessage?)` and `close()`. Always await close in a finally block. Create a new instance for each independent conversation; there is no resume/fork interface. The owner file never enters the SDK's MCP configuration.

The default fixed session TTL is 900 seconds (`ttl`, maximum 86400), with no renewal. Each turn has a 120000 ms deadline (`turnTimeoutMs`, maximum 600000). Reviews stop after 55 seconds. The adapter configures no native tools, other MCP connections, plugins or local hooks. SDK `maxTurns` defaults to 12 and `maxBudgetUsd` to 1; SDK cost estimates are not a hard billing limit. Optional `model` and `claudeExecutable` select the host model/binary.

`GuardHostError` reports incomplete cleanup with `sessionId` and `credentialDirectory`. If revocation cannot be confirmed, the private credential file remains for recovery; retry `close()` or revoke through the owner CLI. A host process killed without cleanup can leave authority until the service's TTL. The owner process, SDK and approval UI are trusted; private files do not isolate malicious same-user code. This is not a process sandbox, exposure ledger or automatic desktop plugin. Compaction does not establish clean context.

Allowed results go to Claude using the host's authentication, after local inspection. The adapter does not call hosted Inspect. Other SDK entry points do not import the optional Claude dependency. [Guide](https://llms.ink/guard/claude/) · [Runnable example](examples/guard-claude.mjs).

Lifecycle tests use real service sockets and subprocess effects with a simulated SDK loop. Run them with `LLMS_INK_GUARD_TEST_PYTHON=/absolute/python npm run test:guard` after installing Python `llms-ink==0.10.0`. The separately opted-in `test:guard:live` requires `LLMS_INK_CLAUDE_LIVE=1`, existing Claude authentication and the optional local model when `LLMS_INK_HOST_REAL_MODEL=1`. Scripted fixture approvals are interoperability evidence, not independent human review or proof of attack prevention.

### Guard host diagnostics

`GuardHostError.code` identifies the failed local check or a fixed host-reported result category. `operationCode` preserves the preceding operation when cleanup fails; the primary `code` then describes cleanup. The terminal example prints both. No raw provider error, prompt, tool output, command or credential is copied into these codes.

- `service_status_failed` / `session_inactive`: check the local service with `llms-ink-guard doctor --config FILE --owner-file FILE` (Python 0.12.0). Start a new conversation after resolving it.
- `guard_connection_failed` / `unexpected_tools` / `session_mismatch` / `host_not_initialized`: the host did not establish the expected guarded conversation. Check host compatibility and configuration; permissions are not broadened.
- `host_stream_failed` / `host_stream_ended` / `host_startup_failed`: the host failed to start or continue. These codes do not establish a provider, authentication or network cause.
- `host_result_error` / `host_turn_limit` / `host_budget_limit` / `host_output_retry_limit`: the host reported an error or one of its configured limits. Only known subtype names are mapped; error text is omitted.
- `message_callback_failed`: the application output callback failed. `turn_timeout`, `session_expired` and `conversation_closed` distinguish adapter deadlines and closure.
- `revocation_unconfirmed`, `host_cleanup_failed` or `credential_cleanup_failed`: retain the reported private directory and retry `close()` or use owner-controlled revocation. Do not treat cleanup as complete.

A failed running turn closes the conversation and attempts revocation; no automatic retry or unguarded fallback occurs. Successful turns may already have performed approved actions, and an error can occur after a tool effect: these codes are not proof of non-execution. Session IDs and recovery paths remain available only for cleanup failures and should not be posted publicly. `host_error` is the fallback for argument/state errors and externally constructed errors.
