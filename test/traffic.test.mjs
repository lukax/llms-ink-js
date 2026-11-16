// AI traffic: agent classification, in-memory aggregation, background sends and their privacy, against a local
// stand-in for POST /api/v0/traffic. Runs under `node --test` and `bun test`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { AI_AGENTS, classifyAgent, classifyOutcome, TRAFFIC_OUTCOMES, trafficCounter, llmsInkHandler, llmsInkExpress } from '../dist/middleware.js';
import { VERSION } from '../dist/index.js';

/** How the stub answers POST /api/v0/traffic. */
const stub = { mode: 'ok', delay: 0, loseAt: 0 };
const accepted = new Map();
/** Every traffic POST: { headers, raw, body }. */
const posts = [];
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://stub');
  if (url.pathname === '/api/v0/llms') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' });
    return res.end('# llms\n');
  }
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    if (stub.mode === 'reset') return req.socket.destroy();
    posts.push({ headers: req.headers, raw, body: JSON.parse(raw) });
    if (stub.mode === 'dedupe') {
      const id = req.headers['idempotency-key']; assert.match(id, /^ink-traffic-v1\.\d{13}\.[a-f0-9]{32}$/);
      if (accepted.has(id)) assert.equal(accepted.get(id), raw); else accepted.set(id, raw);
      if (posts.length === stub.loseAt) return req.socket.destroy();
    }
    const problem = (status, code, extra = {}) => {
      res.writeHead(status, { 'content-type': 'application/problem+json', ...extra });
      res.end(JSON.stringify({ type: 'x', title: 't', status, code, detail: `stub ${code}` }));
    };
    setTimeout(() => {
      if (stub.mode === 'busy') return problem(503, 'unavailable', { 'retry-after': '120' });
      if (stub.mode === 'busy-years') return problem(503, 'unavailable', { 'retry-after': '99999999999' });
      if (stub.mode === 'claimed') return problem(403, 'site_claimed');
      if (stub.mode === 'bad') return problem(400, 'invalid_request');
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }, stub.delay);
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
after(() => {
  server.closeAllConnections();
  server.close();
});
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const KEY = 'lk_' + 'k'.repeat(32);

const UA = {
  chatgpt: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot',
  claudeUser: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +Claude-User@anthropic.com)',
  perplexityUser: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)',
  gptbot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)',
  oaiSearch: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot',
  claudebot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
  perplexitybot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)',
  googlebot: 'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  googleImage: 'Googlebot-Image/1.0',
  bingbot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/116.0.1938.76 Safari/537.36',
  meta: 'meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)',
  chrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  safari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  curl: 'curl/8.7.1',
  llmsInk: 'Mozilla/5.0 (compatible; llms.ink/0.1; +https://llms.ink/about/)',
};

/** Runs `fn` with Date.now() moved by `offset` ms. */
async function shifted(offset, fn) {
  const real = Date.now;
  Date.now = () => real() + offset;
  try { return await fn(); } finally { Date.now = real; }
}
/** console.warn lines while `fn` runs. */
async function warnings(fn) {
  const real = console.warn;
  const lines = [];
  console.warn = (...args) => lines.push(args.join(' '));
  try { await fn(); } finally { console.warn = real; }
  return lines;
}
const req = (path, ua, init = {}) => new Request(`https://example.com${path}`, { ...init, headers: { 'user-agent': ua, ...init.headers } });
const reset = () => { stub.mode = 'ok'; stub.delay = 0; stub.loseAt = 0; posts.length = 0; accepted.clear(); };
const today = () => new Date(Date.now()).toISOString().slice(0, 10);
const sorted = (rows) => [...rows].sort((a, b) => (a.path + a.agent).localeCompare(b.path + b.agent));

test('classifyAgent: user fetches vs crawlers from real User-Agent strings; browsers, curl and others are null', () => {
  const kinds = Object.fromEntries(Object.entries(UA).map(([name, ua]) => [name, classifyAgent(ua) && `${classifyAgent(ua).agent}/${classifyAgent(ua).kind}`]));
  assert.deepEqual(kinds, {
    chatgpt: 'ChatGPT-User/user', claudeUser: 'Claude-User/user', perplexityUser: 'Perplexity-User/user',
    gptbot: 'GPTBot/crawler', oaiSearch: 'OAI-SearchBot/crawler', claudebot: 'ClaudeBot/crawler', perplexitybot: 'PerplexityBot/crawler',
    googlebot: 'Googlebot/crawler', googleImage: 'Googlebot/crawler', bingbot: 'bingbot/crawler', meta: 'meta-externalagent/crawler',
    chrome: null, safari: null, curl: null, llmsInk: null,
  });
  assert.equal(classifyAgent(null), null);
  assert.equal(classifyAgent('gptbot/1.0').agent, 'GPTBot', 'case-insensitive, reported by its canonical name');
  assert.equal(classifyAgent('NotGPTBot/1.0'), null, 'a name glued to another word is not that agent');
  assert.equal(classifyAgent('Mozilla/5.0 (compatible; Claude-SearchBot/1.0)').agent, 'Claude-SearchBot');
});

test('the agent table is data: every entry classifies its own name, names are unique and valid for the API', () => {
  const names = AI_AGENTS.map((a) => a.agent.toLowerCase());
  assert.equal(new Set(names).size, names.length);
  for (const a of AI_AGENTS) {
    assert.ok(a.kind === 'user' || a.kind === 'crawler');
    assert.match(a.agent, /^[A-Za-z][A-Za-z0-9._-]{0,47}$/);
    assert.deepEqual(classifyAgent(`Mozilla/5.0 (compatible; ${a.agent}/1.0; +https://example.org/bot)`), a, a.agent);
  }
  assert.ok(!AI_AGENTS.some((a) => a.agent === 'Google-Extended'), 'robots-only tokens never appear in a User-Agent');
});

test('aggregation: counts per path and agent, query strings stripped, people and non-GET ignored', async () => {
  reset();
  const counter = trafficCounter({ key: KEY, site: 'https://Example.com/', baseUrl });
  for (let i = 0; i < 3; i++) counter.record(req(`/pricing?ref=chat&u=${i}`, UA.chatgpt));
  counter.record(req('/pricing#plans', UA.claudeUser));
  counter.record(req('/docs/', UA.gptbot), undefined);
  counter.record(req('/docs/', UA.gptbot, { method: 'HEAD' }));
  counter.record(req('/docs/', UA.gptbot, { method: 'POST', body: 'x' }));
  counter.record(req('/pricing', UA.chrome));
  counter.record(req('/pricing', UA.curl));
  await counter.flush();
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].body.site, 'example.com');
  assert.equal(posts[0].body.period, today());
  assert.deepEqual(sorted(posts[0].body.rows), [
    { path: '/docs/', agent: 'GPTBot', kind: 'crawler', count: 2 },
    { path: '/pricing', agent: 'ChatGPT-User', kind: 'user', count: 3 },
    { path: '/pricing', agent: 'Claude-User', kind: 'user', count: 1 },
  ]);
  await counter.flush();
  assert.equal(posts.length, 1, 'nothing new, nothing sent');
});

test('privacy: the request carries only site, day, path, agent name, kind and count', async () => {
  reset();
  const counter = trafficCounter({ key: KEY, site: 'example.com', baseUrl });
  counter.record(new Request('https://example.com/account/reset?token=s3cr3t&email=a@b.co', {
    headers: { 'user-agent': UA.chatgpt, cookie: 'session=abc123', 'x-forwarded-for': '198.51.100.23', 'cf-connecting-ip': '198.51.100.23', referer: 'https://chatgpt.com/c/xyz' },
  }));
  await counter.flush();
  const { body, raw, headers } = posts[0];
  assert.deepEqual(Object.keys(body).sort(), ['period', 'rows', 'site']);
  assert.deepEqual(Object.keys(body.rows[0]).sort(), ['agent', 'count', 'kind', 'path']);
  assert.equal(body.rows[0].path, '/account/reset');
  for (const secret of ['s3cr3t', 'a@b.co', 'abc123', '198.51.100.23', 'chatgpt.com/c', 'Mozilla', 'openai.com/bot', 'AppleWebKit']) assert.ok(!raw.includes(secret), secret);
  assert.equal(headers.authorization, `Bearer ${KEY}`);
  assert.equal(headers['user-agent'], `llms-ink-js/${VERSION}`);
  assert.equal(headers['content-type'], 'application/json');
  for (const h of ['cookie', 'x-forwarded-for', 'cf-connecting-ip', 'referer']) assert.equal(headers[h], undefined, h);
});

test('flush timing: nothing is sent before flushEvery; then the send goes to ctx.waitUntil', async () => {
  reset();
  const counter = trafficCounter({ key: KEY, site: 'example.com', flushEvery: 30, baseUrl });
  const kept = [];
  const ctx = { waitUntil: (p) => kept.push(p) };
  counter.record(req('/a', UA.gptbot), ctx);
  await shifted(29_000, () => counter.record(req('/a', UA.gptbot), ctx));
  assert.equal(kept.length, 0);
  assert.equal(posts.length, 0);
  await shifted(31_000, () => counter.record(req('/b', UA.claudebot), ctx));
  assert.equal(kept.length, 1, 'one send, handed to waitUntil');
  await Promise.all(kept);
  assert.equal(posts.length, 1);
  assert.deepEqual(sorted(posts[0].body.rows).map((r) => `${r.path} ${r.agent} ${r.count}`), ['/a GPTBot 2', '/b ClaudeBot 1']);
});

test('without ctx (Node, Bun): an unref\'d timer sends at flushEvery', async () => {
  reset();
  const realSet = globalThis.setTimeout;
  const timers = [];
  globalThis.setTimeout = (fn, ms) => { const t = { fn, ms, unrefed: false, unref() { this.unrefed = true; return this; } }; timers.push(t); return t; };
  let counter;
  try {
    counter = trafficCounter({ key: KEY, site: 'example.com', flushEvery: 20, baseUrl });
    counter.record(req('/x', UA.perplexitybot));
    counter.record(req('/x', UA.perplexitybot));
  } finally {
    globalThis.setTimeout = realSet;
  }
  assert.equal(timers.length, 1, 'one timer, not one per request');
  assert.ok(timers[0].ms > 18_000 && timers[0].ms <= 20_000, String(timers[0].ms));
  assert.equal(timers[0].unrefed, true, 'never holds the process open');
  timers[0].fn();
  await counter.flush();
  assert.deepEqual(posts[0].body.rows, [{ path: '/x', agent: 'PerplexityBot', kind: 'crawler', count: 2 }]);
});

test('backoff: retries retain their identifier and body; new counts are sent separately', async () => {
  reset();
  stub.mode = 'busy';
  const counter = trafficCounter({ key: KEY, site: 'example.com', flushEvery: 10, baseUrl });
  const kept = [];
  const ctx = { waitUntil: (p) => kept.push(p) };
  counter.record(req('/r', UA.gptbot), ctx);
  await shifted(11_000, async () => { counter.record(req('/r', UA.gptbot), ctx); await Promise.all(kept); });
  assert.equal(posts.length, 1, 'tried once');
  stub.mode = 'ok';
  await shifted(60_000, () => counter.record(req('/r', UA.gptbot), ctx));
  assert.equal(kept.length, 1, 'still backing off (Retry-After: 120)');
  await shifted(140_000, async () => { counter.record(req('/r', UA.gptbot), ctx); await Promise.all(kept); });
  assert.equal(kept.length, 2);
  assert.equal(posts.length, 3);
  assert.equal(posts[1].raw, posts[0].raw);
  assert.equal(posts[1].headers['idempotency-key'], posts[0].headers['idempotency-key']);
  assert.notEqual(posts[2].headers['idempotency-key'], posts[0].headers['idempotency-key']);
  assert.deepEqual(posts[2].body.rows, [{ path: '/r', agent: 'GPTBot', kind: 'crawler', count: 2 }], 'new counts stay separate from the unchanged retry');
});

test('a network failure never throws and keeps the counts', async () => {
  reset();
  stub.mode = 'reset';
  const counter = trafficCounter({ key: KEY, site: 'example.com', baseUrl });
  counter.record(req('/n', UA.claudebot));
  await counter.flush();
  stub.mode = 'ok';
  await shifted(3_600_001, () => counter.flush());
  assert.deepEqual(posts.at(-1).body.rows, [{ path: '/n', agent: 'ClaudeBot', kind: 'crawler', count: 1 }]);
});

test('403 site_claimed stops counting with one warning; 400 drops that batch and keeps counting', async () => {
  reset();
  stub.mode = 'claimed';
  const counter = trafficCounter({ key: KEY, site: 'example.com', baseUrl });
  const warned = await warnings(async () => {
    counter.record(req('/', UA.gptbot));
    await counter.flush();
    counter.record(req('/', UA.gptbot));
    await counter.flush();
  });
  assert.equal(posts.length, 1, 'no more sends after the refusal');
  assert.equal(warned.length, 1);
  assert.match(warned[0], /refused example\.com \(403 site_claimed/);

  reset();
  stub.mode = 'bad';
  const other = trafficCounter({ key: KEY, site: 'example.org', baseUrl });
  const warned400 = await warnings(async () => {
    other.record(req('/', UA.gptbot));
    await other.flush();
  });
  assert.match(warned400[0], /rejected a batch for example\.org \(400 invalid_request/);
  stub.mode = 'ok';
  other.record(req('/again', UA.gptbot));
  await other.flush();
  assert.deepEqual(posts.at(-1).body.rows, [{ path: '/again', agent: 'GPTBot', kind: 'crawler', count: 1 }], 'the bad batch was dropped, not resent');
});

test('batching: at most 1000 rows per POST, one POST per UTC day; 1000 pending rows send without waiting', async () => {
  reset();
  const counter = trafficCounter({ key: KEY, site: 'example.com', baseUrl });
  await shifted(-86_400_000, () => counter.record(req('/yesterday', UA.gptbot)));
  for (let i = 0; i < 1499; i++) counter.record(req(`/p/${i}`, UA.gptbot));
  await counter.flush();
  // The 1000th row made a send due on its own; the rest went with the explicit flush.
  const byPeriod = Object.groupBy ? Object.groupBy(posts, (p) => p.body.period) : null;
  assert.ok(posts.every((p) => p.body.rows.length <= 1000));
  assert.equal(posts.reduce((n, p) => n + p.body.rows.length, 0), 1500);
  if (byPeriod) assert.deepEqual(Object.keys(byPeriod).sort(), [new Date(Date.now() - 86_400_000).toISOString().slice(0, 10), today()]);
  assert.ok(posts.every((p) => new Set(p.body.rows.map(() => p.body.period)).size === 1));
});

test('memory stays bounded: past 5000 distinct rows, new paths count as /(other)', async () => {
  reset();
  stub.mode = 'busy';
  const counter = trafficCounter({ key: KEY, site: 'example.com', baseUrl });
  for (let i = 0; i < 5000; i++) counter.record(req(`/m/${i}`, UA.gptbot));
  counter.record(req('/m/new-1', UA.gptbot));
  counter.record(req('/m/new-2', UA.gptbot));
  counter.record(req('/m/0', UA.gptbot));
  await counter.flush();
  stub.mode = 'ok';
  posts.length = 0;
  await shifted(3_600_001, () => counter.flush());
  const rows = posts.flatMap((p) => p.body.rows);
  assert.equal(rows.length, 5001);
  assert.equal(rows.find((r) => r.path === '/(other)').count, 2);
  assert.equal(rows.find((r) => r.path === '/m/0').count, 2);
});

test('a key is required', () => {
  assert.throws(() => trafficCounter({ key: '', site: 'example.com' }), /needs an llms\.ink API key/);
  assert.throws(() => llmsInkHandler({ site: 'example.com', traffic: { key: ' ' } }), TypeError);
});

test('middleware: counts every request it sees, served or not, under its site; never delays the response', async () => {
  reset();
  stub.delay = 1500;
  const handle = llmsInkHandler({ site: 'https://www.example.com', baseUrl, traffic: { key: KEY, flushEvery: 10 } });
  const kept = [];
  const ctx = { waitUntil: (p) => kept.push(p) };
  assert.equal(await handle(req('/blog/post?utm_source=chatgpt', UA.chatgpt), ctx), undefined, 'not ours: the app answers');
  const started = Date.now();
  const res = await shifted(11_000, () => handle(req('/llms.txt', UA.claudeUser), ctx));
  assert.equal(await res.text(), '# llms\n');
  assert.ok(Date.now() - started < 1000, `answered in ${Date.now() - started} ms while the send takes 1500`);
  assert.equal(kept.length, 1);
  await Promise.all(kept);
  assert.equal(posts[0].body.site, 'www.example.com');
  assert.deepEqual(sorted(posts[0].body.rows), [
    { path: '/blog/post', agent: 'ChatGPT-User', kind: 'user', count: 1 },
    { path: '/llms.txt', agent: 'Claude-User', kind: 'user', count: 1 },
  ]);

  reset();
  const custom = llmsInkHandler({ site: 'https://docs.example.com', baseUrl, traffic: { key: KEY, site: 'example.com' } });
  await custom(req('/', UA.gptbot));
  await custom.flush();
  assert.equal(posts[0].body.site, 'example.com', 'traffic.site overrides');
  const plain = llmsInkHandler({ site: 'https://example.com', baseUrl });
  await plain(req('/', UA.gptbot));
  await plain.flush();
  assert.equal(posts.length, 1, 'without traffic nothing is counted or sent');
});

test('Express: llmsInkExpress counts requests from a real Node server and flush() sends them', async () => {
  reset();
  const mw = llmsInkExpress({ site: 'https://example.com', baseUrl, traffic: { key: KEY } });
  const app = createServer((rq, rs) => mw(rq, rs, () => { rs.writeHead(200, { 'content-type': 'text/html' }); rs.end('<h1>app</h1>'); }));
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.address().port}`;
  try {
    for (const [path, ua] of [['/', UA.gptbot], ['/', UA.gptbot], ['/pricing?x=1', UA.perplexityUser], ['/pricing', UA.chrome], ['/llms.txt', UA.oaiSearch]]) {
      const r = await fetch(origin + path, { headers: { 'user-agent': ua } });
      assert.equal(r.status, 200);
      await r.text();
    }
    assert.equal(posts.length, 0, 'counted in memory, not per request');
    await mw.flush();
    assert.deepEqual(sorted(posts[0].body.rows), [
      { path: '/', agent: 'GPTBot', kind: 'crawler', count: 2, outcomes: { ok: 2 } },
      { path: '/llms.txt', agent: 'OAI-SearchBot', kind: 'crawler', count: 1, outcomes: { ok: 1 } },
      { path: '/pricing', agent: 'Perplexity-User', kind: 'user', count: 1, outcomes: { ok: 1 } },
    ]);
  } finally {
    app.closeAllConnections();
    app.close();
  }
});


test('an accepted batch with a lost response retries unchanged without adding counts twice', async () => {
 reset();stub.mode='dedupe';stub.loseAt=1;
 const counter=trafficCounter({key:KEY,site:'example.com',baseUrl});
 counter.record(req('/once',UA.gptbot));await counter.flush();
 counter.record(req('/new',UA.gptbot));await counter.flush();
 assert.equal(posts.length,3);assert.equal(accepted.size,2);
 assert.equal(posts[0].raw,posts[1].raw);assert.equal(posts[0].headers['idempotency-key'],posts[1].headers['idempotency-key']);
 assert.equal([...accepted.values()].flatMap(v=>JSON.parse(v).rows).reduce((n,r)=>n+r.count,0),2);
});
test('a partial multi-batch failure preserves the failed and unsent chunks while keeping new counts separate', async () => {
 reset();stub.mode='dedupe';stub.loseAt=2;
 const counter=trafficCounter({key:KEY,site:'example.com',baseUrl});
 for(let i=0;i<2500;i++)counter.record(req('/many/'+i,UA.gptbot));
 await counter.flush();counter.record(req('/later',UA.gptbot));await counter.flush();
 const rows=[...accepted.values()].flatMap(v=>JSON.parse(v).rows);
 assert.equal(rows.reduce((n,r)=>n+r.count,0),2501);assert.equal(new Set(rows.map(r=>r.path)).size,2501);
 assert.ok(posts.some((p,i)=>posts.findIndex(q=>q.headers['idempotency-key']===p.headers['idempotency-key'])!==i));
});
test('expired uncertain batches are discarded with a warning; new counts use a new identifier', async () => {
 reset();stub.mode='busy';const counter=trafficCounter({key:KEY,site:'example.com',baseUrl});
 counter.record(req('/old',UA.gptbot));await counter.flush();const old=posts[0].headers['idempotency-key'];stub.mode='ok';
 const lines=await warnings(()=>shifted(86400001,async()=>{counter.record(req('/new',UA.gptbot));await counter.flush();}));
 assert.match(lines.join(' '),/retry expired/);assert.equal(posts.filter(p=>p.headers['idempotency-key']===old).length,1);
 assert.equal(posts.at(-1).body.rows[0].path,'/new');
});

const html = (status = 200, type = 'text/html; charset=utf-8') => new Response(status === 204 || status === 304 ? null : '<p>x</p>', { status, headers: type ? { 'content-type': type } : {} });

test('classifyOutcome: status classes, Markdown asked for and not served, and statuses that are not final', () => {
  const r = (path, accept) => req(path, UA.chatgpt, accept ? { headers: { accept } } : {});
  const cases = [
    [r('/'), html(), 'ok'], [r('/'), html(204, null), 'ok'], [r('/'), html(304, null), 'ok'],
    [r('/', 'text/markdown, text/html;q=0.9'), html(), 'markdown_missing'],
    [r('/', 'text/markdown;q=0.5, text/html'), html(), 'ok'],
    [r('/', 'text/markdown'), html(200, 'text/markdown; charset=utf-8'), 'ok'],
    [r('/', 'text/markdown'), html(200, 'TEXT/PLAIN'), 'ok'],
    [r('/', 'text/markdown'), html(200, null), 'ok'],
    [r('/', 'text/markdown'), html(200, 'text/markdownish'), 'markdown_missing'],
    [r('/guide.md'), html(), 'markdown_missing'], [r('/GUIDE.MD'), html(), 'markdown_missing'], [r('/guide.md'), html(200, 'text/x-markdown'), 'ok'],
    [r('/'), html(301), 'redirect'], [r('/'), html(308), 'redirect'],
    [r('/'), html(404), 'not_found'], [r('/'), html(410), 'not_found'],
    [r('/'), html(401), 'blocked'], [r('/'), html(403), 'blocked'], [r('/'), html(451), 'blocked'],
    [r('/'), html(429), 'rate_limited'], [r('/'), html(400), 'client_error'], [r('/'), html(405), 'client_error'],
    [r('/'), html(500), 'server_error'], [r('/'), html(599), 'server_error'],
  ];
  for (const [request, response, want] of cases) assert.equal(classifyOutcome(request, response), want, `${request.url} ${request.headers.get('accept')} ${response.status} ${response.headers.get('content-type')}`);
  for (const status of [0, 100, 199, 600, -1, 200.5, NaN, '200']) assert.equal(classifyOutcome(r('/'), { status, headers: new Headers() }), null, String(status));
  assert.deepEqual([...TRAFFIC_OUTCOMES], ['ok', 'redirect', 'not_found', 'blocked', 'rate_limited', 'client_error', 'server_error', 'markdown_missing']);
});

test('observe: outcomes join the request’s row, once per request; uncounted and unknown requests are ignored; bodies are never read', async () => {
  reset();
  const counter = trafficCounter({ key: KEY, site: 'example.com', baseUrl });
  const a = req('/docs', UA.chatgpt), b = req('/docs', UA.chatgpt), c = req('/gone', UA.gptbot), person = req('/docs', UA.chrome);
  for (const r of [a, b, c, person]) counter.record(r);
  let pulled = false;
  const streamed = new Response(new ReadableStream({ pull() { pulled = true; throw new Error('read'); } }), { headers: { 'content-type': 'text/html' } });
  counter.observe(a, streamed);
  counter.observe(a, html(500)); // a second response for the same request is ignored
  counter.observe(b, html(200, null));
  counter.observe(c, html(404));
  counter.observe(person, html(404));
  counter.observe(req('/docs', UA.chatgpt), html(500)); // a different Request object was never counted
  counter.observe(req('/never', UA.gptbot), html(500));
  counter.observe(c, { status: 'nope', headers: null });
  assert.equal(pulled, false); assert.equal(streamed.bodyUsed, false);
  assert.equal(await streamed.text().catch(() => 'read attempted later'), 'read attempted later', 'the stream is left for the app');
  await counter.flush();
  assert.deepEqual(sorted(posts[0].body.rows), [
    { path: '/docs', agent: 'ChatGPT-User', kind: 'user', count: 2, outcomes: { ok: 2 } },
    { path: '/gone', agent: 'GPTBot', kind: 'crawler', count: 1, outcomes: { not_found: 1 } },
  ]);
});

test('observe after a send: a count-0 row carries the outcome; a response after midnight stays on the request’s day', async () => {
  reset();
  const counter = trafficCounter({ key: KEY, site: 'example.com', baseUrl });
  const early = req('/slow', UA.claudeUser);
  counter.record(early);
  await counter.flush();
  counter.observe(early, html(503));
  await counter.flush();
  assert.deepEqual(posts[1].body.rows, [{ path: '/slow', agent: 'Claude-User', kind: 'user', count: 0, outcomes: { server_error: 1 } }]);

  reset();
  const toMidnight = Date.parse(`${today()}T23:59:59.900Z`) - Date.now();
  const slow = await shifted(toMidnight - 50, () => trafficCounter({ key: KEY, site: 'example.com', baseUrl, flushEvery: 3600 }));
  const late = req('/late', UA.gptbot);
  const before = await shifted(toMidnight, () => { slow.record(late); return today(); });
  const after = await shifted(toMidnight + 200, async () => {
    slow.record(req('/late', UA.gptbot));
    slow.observe(late, html(404));
    await slow.flush();
    return today();
  });
  assert.notEqual(before, after);
  const byDay = Object.fromEntries(posts.map((p) => [p.body.period, p.body.rows]));
  assert.deepEqual(byDay, {
    [before]: [{ path: '/late', agent: 'GPTBot', kind: 'crawler', count: 1, outcomes: { not_found: 1 } }],
    [after]: [{ path: '/late', agent: 'GPTBot', kind: 'crawler', count: 1 }],
  });
});

test('observe past the memory bound: the outcome follows its request into /(other), never a new row', async () => {
  reset();
  const counter = trafficCounter({ key: KEY, site: 'example.com', baseUrl });
  for (let i = 0; i < 5000; i++) counter.record(req(`/m/${i}`, UA.gptbot));
  const extra = req('/overflow', UA.gptbot), first = req('/m/0', UA.gptbot);
  counter.record(extra); counter.record(first);
  counter.observe(extra, html(404)); counter.observe(first, html(301));
  await counter.flush();
  const rows = posts.flatMap((p) => p.body.rows);
  assert.equal(rows.length, 5001);
  assert.deepEqual(rows.find((r) => r.path === '/(other)'), { path: '/(other)', agent: 'GPTBot', kind: 'crawler', count: 1, outcomes: { not_found: 1 } });
  assert.deepEqual(rows.find((r) => r.path === '/m/0').outcomes, { redirect: 1 });
});

test('observe privacy and stop: outcomes are names and counts only; a stopped counter ignores responses', async () => {
  reset();
  const counter = trafficCounter({ key: KEY, site: 'example.com', baseUrl });
  const r = req('/x', UA.chatgpt, { headers: { accept: 'text/markdown' } });
  counter.record(r);
  counter.observe(r, new Response('secret body', { status: 200, headers: { 'content-type': 'text/html; charset=iso-8859-1', 'set-cookie': 'sid=abc', server: 'SecretServer/1' } }));
  await counter.flush();
  assert.deepEqual(Object.keys(posts[0].body.rows[0]).sort(), ['agent', 'count', 'kind', 'outcomes', 'path']);
  assert.deepEqual(posts[0].body.rows[0].outcomes, { markdown_missing: 1 });
  for (const secret of ['secret body', 'text/html', 'iso-8859', 'sid=abc', 'SecretServer', '"status"']) assert.ok(!posts[0].raw.includes(secret), secret);

  reset(); stub.mode = 'claimed';
  const stopped = trafficCounter({ key: KEY, site: 'example.com', baseUrl });
  const s = req('/y', UA.gptbot);
  stopped.record(s);
  await warnings(() => stopped.flush());
  stub.mode = 'ok';
  stopped.observe(s, html(500));
  await stopped.flush();
  assert.equal(posts.length, 1, 'nothing after the stop');
});

test('middleware: its own responses are observed; the app’s through observe(); HEAD and not-ours requests too', async () => {
  reset();
  const llms = llmsInkHandler({ site: 'https://example.com', baseUrl, traffic: { key: KEY } });
  const own = req('/llms.txt', UA.claudeUser);
  assert.equal((await llms(own)).status, 200);
  llms.observe(own, html(500)); // already observed by the handler
  const head = req('/llms.txt', UA.claudeUser, { method: 'HEAD' });
  assert.equal((await llms(head)).body, null);
  for (const [path, response] of [['/missing', html(404)], ['/docs/a.md', html()], ['/docs/a', html()]]) {
    const r = req(path, UA.chatgpt);
    assert.equal(await llms(r), undefined);
    llms.observe(r, response);
  }
  await llms.flush();
  assert.deepEqual(sorted(posts[0].body.rows), sorted([
    { path: '/docs/a', agent: 'ChatGPT-User', kind: 'user', count: 1, outcomes: { ok: 1 } },
    { path: '/docs/a.md', agent: 'ChatGPT-User', kind: 'user', count: 1, outcomes: { markdown_missing: 1 } },
    { path: '/llms.txt', agent: 'Claude-User', kind: 'user', count: 2, outcomes: { ok: 2 } },
    { path: '/missing', agent: 'ChatGPT-User', kind: 'user', count: 1, outcomes: { not_found: 1 } },
  ]));
  const plain = llmsInkHandler({ site: 'https://example.com', baseUrl });
  const r = req('/z', UA.gptbot);
  await plain(r);
  assert.doesNotThrow(() => plain.observe(r, html(404)), 'a no-op without traffic');
});

test('Express: outcomes from a real Node server, including errors, array headers and an aborted response', async () => {
  reset();
  const mw = llmsInkExpress({ site: 'https://example.com', baseUrl, traffic: { key: KEY } });
  const app = createServer((rq, rs) => mw(rq, rs, () => {
    const path = new URL(rq.url, 'http://x').pathname;
    if (path === '/hang') return; // never answers: the client gives up
    if (path === '/boom') { rs.statusCode = 500; return rs.end('err'); }
    if (path === '/gone') { rs.statusCode = 410; return rs.end(); }
    if (path === '/api.md') { rs.setHeader('content-type', ['text/html']); return rs.end('<p>'); }
    rs.setHeader('content-type', 'text/html'); rs.end('<h1>app</h1>');
  }));
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.address().port}`;
  try {
    for (const path of ['/', '/boom', '/gone', '/api.md']) await (await fetch(origin + path, { headers: { 'user-agent': UA.perplexityUser } })).text();
    await fetch(origin + '/hang', { headers: { 'user-agent': UA.perplexityUser }, signal: AbortSignal.timeout(200) }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 100));
    await mw.flush();
    assert.deepEqual(sorted(posts[0].body.rows), sorted([
      { path: '/', agent: 'Perplexity-User', kind: 'user', count: 1, outcomes: { ok: 1 } },
      { path: '/api.md', agent: 'Perplexity-User', kind: 'user', count: 1, outcomes: { markdown_missing: 1 } },
      { path: '/boom', agent: 'Perplexity-User', kind: 'user', count: 1, outcomes: { server_error: 1 } },
      { path: '/gone', agent: 'Perplexity-User', kind: 'user', count: 1, outcomes: { not_found: 1 } },
      { path: '/hang', agent: 'Perplexity-User', kind: 'user', count: 1 },
    ]));
  } finally {
    app.closeAllConnections();
    app.close();
  }
});

test('timers never overflow: huge or invalid flushEvery and Retry-After values do not send at once', async () => {
  for (const flushEvery of [1e12, Infinity, NaN]) {
    reset();
    const counter = trafficCounter({ key: KEY, site: 'example.com', baseUrl, flushEvery });
    counter.record(req('/a', UA.gptbot));
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(posts.length, 0, String(flushEvery));
  }
  reset(); stub.mode = 'busy-years';
  const counter = trafficCounter({ key: KEY, site: 'example.com', baseUrl });
  counter.record(req('/a', UA.gptbot));
  await counter.flush();
  stub.mode = 'ok';
  counter.record(req('/b', UA.gptbot));
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(posts.length, 1, 'the retry waits instead of firing an overflowed timer');
});
