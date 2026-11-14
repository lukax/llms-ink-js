// llmsInkHandler and llmsInkExpress against a local stand-in for the API. Runs under `node --test` and `bun test`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { llmsInkHandler, llmsInkExpress } from '../dist/middleware.js';
import { VERSION } from '../dist/index.js';

/** Stub state the tests flip. */
const stub = { down: false, json: false, maxAge: 3600, delay: 0 };
/** Every request the stub saw: { path, query, headers }. */
const seen = [];
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://stub');
  const query = Object.fromEntries(url.searchParams);
  seen.push({ path: url.pathname, query, headers: req.headers });
  if (stub.down) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'x-error-code': 'unavailable', 'retry-after': '30' });
    return res.end('llms.ink is busy.\n');
  }
  if (stub.json) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end('{"text":"# T"}');
  }
  const body = url.pathname === '/api/v0/llms' ? `# ${query.url} ${query.mode} ${seen.length}\n` : `# Page ${url.pathname} ${seen.length}\n`;
  setTimeout(() => {
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': `public, max-age=${stub.maxAge}, s-maxage=86400`,
      'x-llms-source': 'generated',
      'set-cookie': 'not=passed',
    });
    res.end(body);
  }, stub.delay);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
after(() => {
  server.closeAllConnections();
  server.close();
});
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const reset = () => Object.assign(stub, { down: false, json: false, maxAge: 3600, delay: 0 });
const get = (handler, path, headers = {}, method = 'GET') => handler(new Request(`https://example.com${path}`, { method, headers }));

test('llms.txt and llms-full.txt: the contract query, key, cache headers passed through', async () => {
  reset();
  const handle = llmsInkHandler({ site: 'example.com', key: 'lk_test', baseUrl });
  const res = await get(handle, '/llms.txt');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /^# https:\/\/example\.com\/ llms \d+\n$/);
  assert.equal(res.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(res.headers.get('cache-control'), 'public, max-age=3600, s-maxage=86400');
  assert.equal(res.headers.get('x-llms-source'), 'generated');
  assert.equal(res.headers.get('set-cookie'), null);
  const { path, query, headers } = seen.at(-1);
  assert.equal(path, '/api/v0/llms');
  assert.deepEqual(query, { url: 'https://example.com/', mode: 'llms', native: '0', format: 'text' });
  assert.equal(headers.authorization, 'Bearer lk_test');
  assert.equal(headers['user-agent'], `llms-ink-js/${VERSION}`);

  const full = await get(handle, '/llms-full.txt');
  assert.match(await full.text(), / full /);
  assert.equal(seen.at(-1).query.mode, 'full');
});

test('served from memory within max-age, with Age', async () => {
  reset();
  const handle = llmsInkHandler({ site: 'https://example.com', baseUrl });
  const first = await (await get(handle, '/llms.txt')).text();
  const before = seen.length;
  const again = await get(handle, '/llms.txt');
  assert.equal(await again.text(), first);
  assert.equal(seen.length, before);
  assert.match(again.headers.get('age'), /^\d+$/);
  assert.equal(seen.at(-1).headers.authorization, undefined);
});

test('concurrent requests share one upstream fetch', async () => {
  reset();
  stub.delay = 50;
  const handle = llmsInkHandler({ site: 'https://example.com', baseUrl });
  const before = seen.length;
  const bodies = await Promise.all([1, 2, 3].map(async () => (await get(handle, '/llms.txt')).text()));
  assert.equal(seen.length - before, 1);
  assert.equal(new Set(bodies).size, 1);
});

test('upstream error: last good copy, marked stale; without one, llms.ink\'s error', async () => {
  reset();
  stub.maxAge = 0;
  const handle = llmsInkHandler({ site: 'https://example.com', baseUrl });
  const good = await (await get(handle, '/llms.txt')).text();
  stub.down = true;
  const stale = await get(handle, '/llms.txt');
  assert.equal(stale.status, 200);
  assert.equal(await stale.text(), good);
  assert.equal(stale.headers.get('warning'), '110 - "Response is Stale"');
  assert.equal(stale.headers.get('cache-control'), 'public, max-age=60');

  const error = await get(handle, '/llms-full.txt');
  assert.equal(error.status, 503);
  assert.equal(error.headers.get('x-error-code'), 'unavailable');
  assert.equal(error.headers.get('retry-after'), '30');
  assert.equal(await error.text(), 'llms.ink is busy.\n');
});

test('unreachable llms.ink: 502 upstream_error, or the last good copy', async () => {
  reset();
  const handle = llmsInkHandler({ site: 'https://example.com', baseUrl: 'http://127.0.0.1:9' });
  const res = await get(handle, '/llms.txt');
  assert.equal(res.status, 502);
  assert.equal(res.headers.get('x-error-code'), 'upstream_error');
  assert.match(await res.text(), /^Couldn't reach llms\.ink/);
});

test('an llms.ink without format=text (JSON) is never served as the file', async () => {
  reset();
  stub.json = true;
  const handle = llmsInkHandler({ site: 'https://example.com', baseUrl });
  const res = await get(handle, '/llms.txt');
  assert.equal(res.status, 502);
  assert.match(await res.text(), /application\/json, not text/);
});

test('HEAD: headers without a body', async () => {
  reset();
  const handle = llmsInkHandler({ site: 'https://example.com', baseUrl });
  const res = await get(handle, '/llms.txt', {}, 'HEAD');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(res.body, null);
});

test('everything else is undefined: other paths, other methods, llms.ink\'s own fetcher', async () => {
  reset();
  const handle = llmsInkHandler({ site: 'https://example.com', baseUrl });
  const before = seen.length;
  assert.equal(await get(handle, '/'), undefined);
  assert.equal(await get(handle, '/llms.txt', {}, 'POST'), undefined);
  assert.equal(await get(handle, '/docs/page.md'), undefined, 'markdown is off by default');
  assert.equal(await get(handle, '/docs/page', { accept: 'text/markdown' }), undefined);
  const fetcher = { 'user-agent': 'Mozilla/5.0 (compatible; llms.ink/0.1; +https://llms.ink/about/)' };
  assert.equal(await get(handle, '/llms.txt', fetcher), undefined);
  assert.equal(seen.length, before);
});

test('markdown: <path>.md and Accept: text/markdown answer the page from /full/', async () => {
  reset();
  const handle = llmsInkHandler({ site: 'https://example.com', markdown: true, baseUrl });
  const md = await get(handle, '/docs/page.md');
  assert.equal(md.status, 200);
  assert.equal(seen.at(-1).path, '/full/example.com/docs/page');
  assert.match(await md.text(), /^# Page \/full\/example\.com\/docs\/page/);

  await get(handle, '/docs/index.md');
  assert.equal(seen.at(-1).path, '/full/example.com/docs/');
  await get(handle, '/index.md');
  assert.equal(seen.at(-1).path, '/full/example.com/');

  const negotiated = await get(handle, '/guide/intro', { accept: 'text/markdown, text/html;q=0.9, */*;q=0.8' });
  assert.equal(negotiated.status, 200);
  assert.equal(seen.at(-1).path, '/full/example.com/guide/intro');
  assert.equal(negotiated.headers.get('vary'), 'Accept');
  assert.ok(await get(handle, '/about.html', { accept: 'text/markdown' }));
  assert.ok(await get(handle, '/pricing', { accept: 'text/markdown, */*' }), 'ties go to markdown');

  const fetcher = { accept: 'text/markdown', 'user-agent': 'Mozilla/5.0 (compatible; llms.ink/0.1; +https://llms.ink/about/)' };
  assert.equal(await get(handle, '/docs/page', fetcher), undefined, 'llms.ink reading the page gets the app');
  assert.equal(await get(handle, '/docs/page.md', fetcher), undefined);
});

test('markdown: browsers and assets get the app', async () => {
  reset();
  const handle = llmsInkHandler({ site: 'https://example.com', markdown: true, baseUrl });
  const browser = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
  assert.equal(await get(handle, '/docs/page', { accept: browser }), undefined);
  assert.equal(await get(handle, '/docs/page', { accept: 'text/html, text/markdown;q=0.5' }), undefined);
  assert.equal(await get(handle, '/docs/page', { accept: '*/*' }), undefined);
  assert.equal(await get(handle, '/docs/page'), undefined);
  assert.equal(await get(handle, '/app.js', { accept: 'text/markdown' }), undefined);
  assert.equal(await get(handle, '/docs/page', { accept: 'text/markdown;q=0' }), undefined);
});

test('express adapter: serves its paths, next() for the rest', async () => {
  reset();
  const middleware = llmsInkExpress({ site: 'https://example.com', baseUrl });
  const app = createServer((req, res) => {
    middleware(req, res, (err) => {
      res.statusCode = err ? 500 : 404;
      res.end(err ? 'error' : 'app');
    });
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  try {
    const origin = `http://127.0.0.1:${app.address().port}`;
    const llms = await fetch(`${origin}/llms.txt`);
    assert.equal(llms.status, 200);
    assert.equal(llms.headers.get('cache-control'), 'public, max-age=3600, s-maxage=86400');
    assert.match(await llms.text(), /^# https:\/\/example\.com\/ llms/);
    const other = await fetch(`${origin}/`);
    assert.equal(other.status, 404);
    assert.equal(await other.text(), 'app');
  } finally {
    app.closeAllConnections();
    app.close();
  }
});
