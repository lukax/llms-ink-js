// The client against a local stand-in for the API. Runs under `node --test` and `bun test`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  LlmsInk, LlmsInkError, InvalidKeyError, RateLimitedError, QuotaExceededError, VERSION,
} from '../dist/index.js';

const RESULT = {
  url: 'https://example.com/', kind: 'site', source: 'generated', mode: 'llms', title: 'Example',
  text: '# Example\n', tokens: 3, pages: 1, model: null, cached: false, generatedAt: '2026-11-14T00:00:00.000Z',
};
const CHECK = {
  site: 'https://example.com', url: 'https://example.com/llms.txt', found: true, status: 200, title: 'Example',
  tokens: 3, sections: 1, links: { total: 1, checked: 1, broken: [] }, llmsFull: false, issues: [],
  summary: { errors: 0, warnings: 0 }, checkedAt: '2026-11-14T00:00:00.000Z',
  parsed: {
    title: 'Example', summary: 'An example.', details: null,
    sections: [{ name: 'Docs', optional: false, text: null, links: [{ title: 'A', url: 'https://example.com/a', notes: 'first', line: 5 }] }],
  },
};
const CHECK_TEXT = { ...CHECK, site: null, url: null, llmsFull: null, links: { total: 1, checked: 0, broken: [] } };
const REPORT = {
  url: 'https://example.com/', site: 'https://example.com', checkedAt: '2026-11-14T00:00:00.000Z',
  summary: { pass: 1, warn: 0, fail: 0, info: 0 },
  sections: [{ id: 'access', title: 'Access', checks: [{ id: 'firewall', status: 'pass', title: 'Firewall', detail: 'Bots get the page.' }] }],
};

/** Every request the stub saw: { path, query, headers }. */
const seen = [];
const problem = (res, status, code, detail, extra = {}, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/problem+json', ...headers });
  res.end(JSON.stringify({ type: 'https://llms.ink/docs/#errors', title: 'T', status, code, detail, ...extra }));
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://stub');
  const q = Object.fromEntries(url.searchParams);
  let body = '';
  for await (const chunk of req) body += chunk;
  seen.push({ method: req.method, path: url.pathname, query: q, headers: req.headers, body });
  if (req.method === 'POST' && url.pathname === '/api/v0/check') {
    if (!body.trim()) return problem(res, 400, 'invalid_request', 'Empty body.');
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(q.base ? { ...CHECK_TEXT, url: q.base, site: new URL(q.base).origin } : CHECK_TEXT));
  }
  if (req.method === 'POST' && url.pathname === '/api/v0/markdown') {
    if (!/^text\/html/.test(req.headers['content-type'] ?? '')) return problem(res, 415, 'unsupported_media_type', 'Send HTML.');
    if (body.length > 100) return problem(res, 413, 'too_large', 'Too large.');
    res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
    return res.end(`# From ${q.url ?? 'nowhere'}\n\n${body.replace(/<[^>]+>/g, '')}\n`);
  }
  const target = q.url ?? '';
  if (req.headers.authorization === 'Bearer lk_bad') return problem(res, 401, 'invalid_key', 'Unknown key.');
  if (target === 'rate.test') return problem(res, 429, 'rate_limited', 'Slow down.', {}, { 'retry-after': '42' });
  if (target === 'quota.test') {
    return problem(res, 429, 'quota_exceeded', 'Quota used.', {}, { 'retry-after': new Date(Date.now() + 60_000).toUTCString() });
  }
  if (target === 'bad.test') {
    return problem(res, 400, 'invalid_request', 'Bad.', { errors: [{ path: 'mode', message: 'nope' }] });
  }
  if (target === 'html.test') { res.writeHead(502, { 'content-type': 'text/html' }); return res.end('<h1>Bad gateway</h1>'); }
  if (target === 'notjson.test') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('hello'); }
  if (url.pathname === '/api/v0/report') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(REPORT));
  }
  if (url.pathname === '/api/v0/check') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(CHECK));
  }
  if (url.pathname === '/api/v0/llms') {
    if (target === 'slow.test') {
      const timer = setTimeout(() => res.end('{}'), 5000);
      return res.on('close', () => clearTimeout(timer));
    }
    if (req.headers.accept?.includes('application/x-ndjson') && target !== 'json.test') {
      res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8' });
      const lines = [
        { type: 'progress', stage: 'cache', detail: 'Checking saved results…' },
        { type: 'future', whatever: 1 },
        { type: 'progress', stage: 'index', detail: 'Index ready · 1 links' },
        { type: 'partial', text: '# Exa' },
        target === 'fail.test'
          ? { type: 'error', detail: 'Quota used.', code: 'quota_exceeded', status: 429 }
          : { type: 'result', result: { ...RESULT, mode: q.mode } },
      ].map((e) => JSON.stringify(e) + '\n').join('');
      // Split mid-line and mid-character (the ellipsis) to exercise buffering and UTF-8 decoding.
      const bytes = Buffer.from(lines);
      const cuts = [7, 31, 32, 33, 90, bytes.length];
      let from = 0;
      const next = () => {
        const to = cuts.shift();
        if (to === undefined) return res.end();
        res.write(bytes.subarray(from, to));
        from = to;
        setTimeout(next, 2);
      };
      return next();
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ...RESULT, mode: q.mode }));
  }
  problem(res, 404, 'not_found', 'No such endpoint.');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
// Bun's test runner ignores unref(); close the server and any open stream instead.
after(() => {
  server.closeAllConnections();
  server.close();
});
const baseUrl = `http://127.0.0.1:${server.address().port}/`;
const ink = new LlmsInk({ baseUrl, key: '' });

test('VERSION matches package.json and jsr.json', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const file of ['package.json', 'jsr.json']) {
    const { version } = JSON.parse(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'));
    assert.equal(version, VERSION, file);
  }
});
const last = () => seen.at(-1);

test('llms: query, headers and the typed result', async () => {
  const result = await ink.llms('example.com', { mode: 'full', fresh: true });
  assert.deepEqual(result, { ...RESULT, mode: 'full' });
  assert.equal(last().path, '/api/v0/llms');
  assert.deepEqual(last().query, { url: 'example.com', mode: 'full', fresh: '1' });
  assert.equal(last().headers.accept, 'application/json');
  assert.equal(last().headers['user-agent'], `llms-ink-js/${VERSION}`);
  assert.equal(last().headers.authorization, undefined);
});

test('llms: defaults to mode llms without fresh', async () => {
  await ink.llms('example.com');
  assert.deepEqual(last().query, { url: 'example.com', mode: 'llms' });
});

test('llms: native false sends native=0; true sends nothing', async () => {
  await ink.llms('example.com', { native: false });
  assert.deepEqual(last().query, { url: 'example.com', mode: 'llms', native: '0' });
  await ink.llms('example.com', { native: true });
  assert.deepEqual(last().query, { url: 'example.com', mode: 'llms' });
});

test('llms: rejects an unknown mode before any request', async () => {
  const before = seen.length;
  await assert.rejects(ink.llms('example.com', { mode: 'index' }), TypeError);
  assert.equal(seen.length, before);
});

test('report: query and result', async () => {
  assert.deepEqual(await ink.report('example.com'), REPORT);
  assert.equal(last().path, '/api/v0/report');
  assert.deepEqual(last().query, { url: 'example.com' });
  assert.equal(last().headers.accept, 'application/json');
  await assert.rejects(ink.report('rate.test'), RateLimitedError);
});

test('check: query and result', async () => {
  assert.deepEqual(await ink.check('example.com'), CHECK);
  assert.equal(last().path, '/api/v0/check');
  assert.deepEqual(last().query, { url: 'example.com' });
});

test('check: GET returns parsed', async () => {
  const result = await ink.check('example.com');
  assert.equal(last().method, 'GET');
  assert.equal(result.parsed.sections[0].links[0].notes, 'first');
});

test('checkText: POSTs the text as markdown, no query by default', async () => {
  const result = await ink.checkText('# Example\n');
  assert.deepEqual(result, CHECK_TEXT);
  assert.equal(last().method, 'POST');
  assert.equal(last().path, '/api/v0/check');
  assert.deepEqual(last().query, {});
  assert.equal(last().body, '# Example\n');
  assert.match(last().headers['content-type'], /^text\/markdown/);
  assert.equal(last().headers['user-agent'], `llms-ink-js/${VERSION}`);
  assert.equal(result.site, null);
  assert.equal(result.llmsFull, null);
});

test('checkText: base and links', async () => {
  const result = await ink.checkText('# X', { base: 'https://example.com/llms.txt', links: true });
  assert.deepEqual(last().query, { base: 'https://example.com/llms.txt', links: '1' });
  assert.equal(result.url, 'https://example.com/llms.txt');
  await ink.checkText('# X', { links: false });
  assert.deepEqual(last().query, {});
});

test('checkText: problem → LlmsInkError', async () => {
  const err = await ink.checkText('  ').catch((e) => e);
  assert.ok(err instanceof LlmsInkError);
  assert.equal(err.code, 'invalid_request');
  assert.equal(err.status, 400);
});

test('markdown: POSTs the HTML as text/html with url, answers the Markdown text; problems → LlmsInkError', async () => {
  const md = await ink.markdown('<h1>Hi</h1>', { url: 'https://example.com/a' });
  assert.equal(md, '# From https://example.com/a\n\nHi\n');
  assert.equal(last().method, 'POST');
  assert.equal(last().path, '/api/v0/markdown');
  assert.deepEqual(last().query, { url: 'https://example.com/a' });
  assert.equal(last().body, '<h1>Hi</h1>');
  assert.equal(last().headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(last().headers.accept, 'text/markdown');
  assert.equal(await ink.markdown('<p>x</p>'), '# From nowhere\n\nx\n');
  assert.deepEqual(last().query, {});
  const err = await ink.markdown(`<p>${'x'.repeat(200)}</p>`).catch((e) => e);
  assert.ok(err instanceof LlmsInkError);
  assert.equal(err.status, 413);
  assert.equal(err.code, 'too_large');
});

test('key: option and LLMS_INK_KEY, sent as Bearer', async () => {
  await new LlmsInk({ baseUrl, key: ' lk_opt ' }).llms('example.com');
  assert.equal(last().headers.authorization, 'Bearer lk_opt');
  process.env.LLMS_INK_KEY = 'lk_env';
  try {
    const client = new LlmsInk({ baseUrl });
    assert.equal(client.key, 'lk_env');
    await client.check('example.com');
    assert.equal(last().headers.authorization, 'Bearer lk_env');
  } finally {
    delete process.env.LLMS_INK_KEY;
  }
  assert.equal(new LlmsInk({ baseUrl }).key, undefined);
});

test('baseUrl: LLMS_INK_API, trailing slash trimmed, default llms.ink', () => {
  assert.equal(new LlmsInk({ baseUrl: 'http://x.test///' }).baseUrl, 'http://x.test');
  process.env.LLMS_INK_API = 'http://env.test/';
  try {
    assert.equal(new LlmsInk().baseUrl, 'http://env.test');
  } finally {
    delete process.env.LLMS_INK_API;
  }
  assert.equal(new LlmsInk().baseUrl, 'https://llms.ink');
});

test('errors: invalid key → InvalidKeyError, never anonymous', async () => {
  const err = await new LlmsInk({ baseUrl, key: 'lk_bad' }).llms('example.com').catch((e) => e);
  assert.ok(err instanceof InvalidKeyError && err instanceof LlmsInkError);
  assert.equal(err.name, 'InvalidKeyError');
  assert.equal(err.status, 401);
  assert.equal(err.code, 'invalid_key');
  assert.equal(err.detail, 'Unknown key.');
  assert.equal(err.message, 'Unknown key.');
});

test('errors: rate_limited with Retry-After seconds', async () => {
  const err = await ink.llms('rate.test').catch((e) => e);
  assert.ok(err instanceof RateLimitedError);
  assert.equal(err.status, 429);
  assert.equal(err.retryAfter, 42);
});

test('errors: quota_exceeded with Retry-After as an HTTP date', async () => {
  const err = await ink.check('quota.test').catch((e) => e);
  assert.ok(err instanceof QuotaExceededError);
  assert.ok(err.retryAfter > 50 && err.retryAfter <= 60, `retryAfter ${err.retryAfter}`);
});

test('errors: invalid_request keeps per-parameter issues and title', async () => {
  const err = await ink.llms('bad.test').catch((e) => e);
  assert.equal(err.constructor, LlmsInkError);
  assert.equal(err.code, 'invalid_request');
  assert.equal(err.title, 'T');
  assert.deepEqual(err.errors, [{ path: 'mode', message: 'nope' }]);
});

test('errors: a non-problem error body falls back to the status line', async () => {
  const err = await ink.llms('html.test').catch((e) => e);
  assert.equal(err.constructor, LlmsInkError);
  assert.equal(err.status, 502);
  assert.equal(err.code, undefined);
  assert.match(err.message, /^HTTP 502/);
});

test('errors: a 200 that is not JSON', async () => {
  const err = await ink.llms('notjson.test').catch((e) => e);
  assert.ok(err instanceof LlmsInkError);
  assert.match(err.message, /other than JSON/);
});

test('errors: unreachable host → LlmsInkError without status', async () => {
  const err = await new LlmsInk({ baseUrl: 'http://127.0.0.1:1' }).llms('example.com').catch((e) => e);
  assert.ok(err instanceof LlmsInkError);
  assert.equal(err.status, undefined);
  assert.match(err.message, /^Couldn't reach http:\/\/127\.0\.0\.1:1/);
  assert.ok(err.cause);
});

test('signal: an abort passes through unwrapped', async () => {
  const err = await ink.llms('slow.test', { signal: AbortSignal.timeout(50) }).catch((e) => e);
  assert.ok(!(err instanceof LlmsInkError));
  assert.ok(['AbortError', 'TimeoutError'].includes(err.name), err.name);
});

test('fetch option replaces the global fetch', async () => {
  const calls = [];
  const fetch = async (input, init) => {
    calls.push({ input: String(input), init });
    return new Response(JSON.stringify(CHECK), { headers: { 'content-type': 'application/json' } });
  };
  const result = await new LlmsInk({ baseUrl: 'http://custom.test', key: 'lk_x', fetch }).check('a b');
  assert.deepEqual(result, CHECK);
  assert.equal(calls[0].input, 'http://custom.test/api/v0/check?url=a+b');
  assert.equal(calls[0].init.headers.authorization, 'Bearer lk_x');
});

test('stream: progress, partial, then result; unknown event types skipped', async () => {
  const events = [];
  for await (const event of ink.stream('example.com', { mode: 'full' })) events.push(event);
  assert.equal(last().headers.accept, 'application/x-ndjson');
  assert.deepEqual(events, [
    { type: 'progress', stage: 'cache', detail: 'Checking saved results…' },
    { type: 'progress', stage: 'index', detail: 'Index ready · 1 links' },
    { type: 'partial', text: '# Exa' },
    { type: 'result', result: { ...RESULT, mode: 'full' } },
  ]);
});

test('stream: a terminal error event is thrown, typed', async () => {
  const events = [];
  const err = await (async () => { for await (const e of ink.stream('fail.test')) events.push(e.type); })().catch((e) => e);
  assert.ok(err instanceof QuotaExceededError);
  assert.equal(err.status, 429);
  assert.equal(err.detail, 'Quota used.');
  assert.deepEqual(events, ['progress', 'progress', 'partial']);
});

test('stream: an error before streaming is a problem response', async () => {
  const err = await (async () => { for await (const _ of ink.stream('rate.test')); })().catch((e) => e);
  assert.ok(err instanceof RateLimitedError);
  assert.equal(err.retryAfter, 42);
});

test('stream: a plain JSON answer becomes one result event', async () => {
  const events = [];
  for await (const event of ink.stream('json.test')) events.push(event);
  assert.deepEqual(events, [{ type: 'result', result: { ...RESULT, mode: 'llms' } }]);
});

test('stream: breaking out early stops cleanly', async () => {
  for await (const event of ink.stream('example.com')) {
    assert.equal(event.type, 'progress');
    break;
  }
});
