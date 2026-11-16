// Web Bot Auth (src/signatures.ts): RFC 9421 Ed25519 signatures from known signers, against hand-written signature
// bases signed with the RFC 9421 test key; forged, expired, unbound and unsupported signatures; directory fetching
// limits (only known signers, no redirects, size and cache bounds); and counting through the traffic counter.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { verifySignedAgent, SIGNED_AGENTS, trafficCounter } from '../dist/middleware.js';

// RFC 8037 A.1 Ed25519 key; A.3 gives its RFC 7638 thumbprint, the `keyid` signers send.
const PRIVATE = { kty: 'OKP', crv: 'Ed25519', x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo', d: 'nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A' };
const KEYID = 'kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k';
const OTHER = { kty: 'OKP', crv: 'Ed25519', x: 'JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs' }; // RFC 9421's test key: a different public key
const key = await crypto.subtle.importKey('jwk', PRIVATE, { name: 'Ed25519' }, false, ['sign']);
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const T0 = 1_800_000_000; // seconds; each test uses its own time so directory caches don't leak between tests
let clock = T0;
const nextTime = () => (clock += 100_000);

/** Directory responses by signer origin, and every directory fetch. */
const directories = new Map();
const fetched = [];
const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (!u.includes('/.well-known/http-message-signatures-directory')) return realFetch(url, init);
    fetched.push({ url: u, redirect: init?.redirect, accept: init?.headers?.accept });
    const make = directories.get(new URL(u).origin);
    return make ? make() : new Response('not found', { status: 404 });
  };
});
after(() => { globalThis.fetch = realFetch; });
const jwks = (keys = [{ kty: 'OKP', crv: 'Ed25519', x: PRIVATE.x, kid: KEYID }], headers = {}) => () =>
  new Response(JSON.stringify({ keys }), { headers: { 'content-type': 'application/http-message-signatures-directory+json', 'cache-control': 'max-age=3600', ...headers } });
directories.set('https://chatgpt.com', jwks());

/**
 * A signed request. The signature base is written out here, line by line as RFC 9421 §2.5 specifies, rather than
 * built by the code under test.
 */
async function signed({ url = 'https://docs.example.com/guide', ua = 'Mozilla/5.0 (Macintosh) Chrome/131.0', agent = 'sig1="https://chatgpt.com"', agentComponent = '"signature-agent";key="sig1"', agentValue = '"https://chatgpt.com"', components, created, expires, params, keyid = KEYID, label = 'sig1', tamper } = {}) {
  created ??= clock - 10;
  expires ??= created + 3600;
  const covered = components ?? [['"@authority"', new URL(url).host], [agentComponent, agentValue]];
  const list = `(${covered.map(([id]) => id).join(' ')})`;
  const sigParams = params ?? `${list};created=${created};expires=${expires};keyid="${keyid}";alg="ed25519";tag="web-bot-auth"`;
  const base = [...covered.map(([id, value]) => `${id}: ${value}`), `"@signature-params": ${sigParams}`].join('\n');
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, new TextEncoder().encode(base)));
  if (tamper) signature[0] ^= 1;
  return new Request(tamper === 'url' ? url.replace('docs.', 'evil.') : url, {
    headers: { 'user-agent': ua, 'signature-input': `${label}=${sigParams}`, signature: `${label}=:${b64(signature)}:`, ...(agent !== null && { 'signature-agent': agent }) },
  });
}
const verify = (request, now = clock) => verifySignedAgent(request, now * 1000);

test('a valid signature from a known signer verifies, keyed by thumbprint; the known signers are data', async () => {
  nextTime();
  assert.deepEqual(await verify(await signed()), SIGNED_AGENTS[0]);
  assert.equal(fetched.at(-1).url, 'https://chatgpt.com/.well-known/http-message-signatures-directory');
  assert.equal(fetched.at(-1).redirect, 'manual');
  assert.match(fetched.at(-1).accept, /application\/http-message-signatures-directory\+json/);
  const before = fetched.length;
  assert.deepEqual(await verify(await signed()), SIGNED_AGENTS[0], 'second request from cache');
  assert.equal(fetched.length, before);
  for (const s of SIGNED_AGENTS) {
    assert.match(s.signer, /^https:\/\/[a-z0-9.-]+$/);
    assert.match(s.agent, /^[A-Za-z][A-Za-z0-9._-]{0,47}$/, 'a name the traffic API accepts');
  }
});

test('legacy bare-string Signature-Agent, the well-known URL form and extra covered components verify', async () => {
  nextTime();
  assert.ok(await verify(await signed({ agent: '"https://chatgpt.com"', agentComponent: '"signature-agent"' })), 'legacy string');
  const wk = 'https://chatgpt.com/.well-known/http-message-signatures-directory';
  assert.ok(await verify(await signed({ agent: `sig1="${wk}"`, agentValue: `"${wk}"` })), 'well-known URL');
  const url = 'https://docs.example.com/a/b?x=1&y=2';
  assert.ok(await verify(await signed({ url, components: [['"@method"', 'GET'], ['"@path"', '/a/b'], ['"@query"', '?x=1&y=2'], ['"@authority"', 'docs.example.com'], ['"@target-uri"', url], ['"user-agent"', 'Mozilla/5.0 (Macintosh) Chrome/131.0'], ['"signature-agent";key="sig1"', '"https://chatgpt.com"']] })));
  // Google's labelled form: a different label and a second, unrelated member.
  directories.set('https://agent.bot.goog', jwks());
  const google = await signed({ label: 'g', agent: 'g="https://agent.bot.goog", other="https://x.example"', agentComponent: '"signature-agent";key="g"', agentValue: '"https://agent.bot.goog"' });
  assert.equal((await verify(google))?.agent, 'Google-Agent');
});

test('forged, tampered and replayed-elsewhere signatures fail', async () => {
  nextTime();
  assert.equal(await verify(await signed({ tamper: true })), null, 'flipped signature bit');
  assert.equal(await verify(await signed({ tamper: 'url' })), null, 'signature for another host');
  const request = await signed();
  const moved = new Request(request.url, { headers: { ...Object.fromEntries(request.headers), 'signature-agent': 'sig1="https://agent.bot.goog"' } });
  assert.equal(await verify(moved), null, 'covered signer swapped');
  assert.equal(await verify(await signed({ keyid: 'x'.repeat(43) })), null, 'unknown keyid');
  directories.set('https://chatgpt.com', jwks([OTHER]));
  assert.equal(await verify(await signed(), nextTime()), null, 'the directory no longer publishes the key');
  directories.set('https://chatgpt.com', jwks());
});

test('time bounds: expired, created in the future, lifetimes over 24 hours, and expired directory keys', async () => {
  const now = nextTime();
  assert.equal(await verify(await signed({ created: now - 7200, expires: now - 1 })), null);
  assert.equal(await verify(await signed({ created: now + 120, expires: now + 3600 })), null);
  assert.ok(await verify(await signed({ created: now + 30, expires: now + 3600 })), 'small clock skew');
  assert.equal(await verify(await signed({ created: now - 10, expires: now + 90_000 })), null);
  assert.equal(await verify(await signed({ created: now, expires: now })), null);
  directories.set('https://chatgpt.com', jwks([{ ...OTHER, x: PRIVATE.x, exp: now + 50_000 }]));
  const later = nextTime();
  assert.equal(await verify(await signed({ created: later - 10 }), later), null, 'key past its exp');
  directories.set('https://chatgpt.com', jwks());
});

test('profile rules: tag, covered authority and signer, label binding, algorithm, duplicates, unsupported components', async () => {
  const now = nextTime();
  const list = '("@authority" "signature-agent";key="sig1")';
  const p = (rest) => `${list};created=${now - 10};expires=${now + 60};keyid="${KEYID}"${rest}`;
  assert.equal(await verify(await signed({ params: p(';tag="other"') })), null, 'tag');
  assert.equal(await verify(await signed({ params: p('') })), null, 'no tag');
  assert.equal(await verify(await signed({ params: p(';alg="rsa-pss-sha512";tag="web-bot-auth"') })), null, 'algorithm');
  assert.ok(await verify(await signed({ params: p(';tag="web-bot-auth"') })), 'alg is optional');
  assert.equal(await verify(await signed({ components: [['"signature-agent";key="sig1"', '"https://chatgpt.com"']] })), null, 'authority not covered');
  assert.equal(await verify(await signed({ components: [['"@authority"', 'docs.example.com']] })), null, 'signer not covered');
  assert.equal(await verify(await signed({ agent: 'other="https://chatgpt.com"', agentComponent: '"signature-agent";key="other"' })), null, 'member of another label');
  assert.equal(await verify(await signed({ agent: 'sig1="https://chatgpt.com";x=1' })), null, 'member with parameters');
  assert.equal(await verify(await signed({ components: [['"@authority"', 'docs.example.com'], ['"@authority"', 'docs.example.com'], ['"signature-agent";key="sig1"', '"https://chatgpt.com"']] })), null, 'duplicate component');
  assert.equal(await verify(await signed({ components: [['"@authority"', 'docs.example.com'], ['"@query-param";name="x"', '1'], ['"signature-agent";key="sig1"', '"https://chatgpt.com"']] })), null, 'unsupported component');
  assert.equal(await verify(await signed({ agent: null })), null, 'no Signature-Agent');
  for (const junk of ['sig1=', 'sig1=("@authority"', '((()))', 'sig1=:not base64!:', 'SIG1=()']) {
    const r = await signed();
    assert.equal(await verify(new Request(r.url, { headers: { ...Object.fromEntries(r.headers), 'signature-input': junk } })), null, junk);
  }
});

test('only known signer origins are fetched: no other hosts, paths, schemes or credentials', async () => {
  nextTime();
  const before = fetched.length;
  for (const value of ['https://evil.example', 'http://chatgpt.com', 'https://chatgpt.com/user/jwks.json', 'https://user@chatgpt.com', 'https://chatgpt.com.evil.example', 'https://169.254.169.254', 'not a url']) {
    assert.equal(await verify(await signed({ agent: `sig1="${value}"`, agentValue: `"${value}"` })), null, value);
  }
  assert.equal(fetched.length, before, 'no directory requested for any of them');
});

test('directory failures never verify and are retried only after the minimum cache time; one fetch serves concurrent requests', async () => {
  const cases = [
    () => new Response('', { status: 301, headers: { location: 'https://evil.example/keys' } }),
    () => new Response('{}', { status: 500 }),
    () => new Response('not json'),
    () => new Response(JSON.stringify({ keys: 'no' })),
    () => new Response(JSON.stringify({ keys: [{ kty: 'RSA', n: 'x', e: 'AQAB' }, { kty: 'OKP', crv: 'X25519', x: PRIVATE.x }, { kty: 'OKP', crv: 'Ed25519', x: 'short' }] })),
    () => new Response(`{"keys":[${'{"kty":"OKP","crv":"Ed25519","x":"' + PRIVATE.x + '"},'.repeat(2000)}{}]}`),
    () => { throw new TypeError('network down'); },
  ];
  for (const make of cases) {
    const now = nextTime();
    directories.set('https://chatgpt.com', make);
    assert.equal(await verify(await signed(), now), null);
    directories.set('https://chatgpt.com', jwks());
    const before = fetched.length;
    assert.equal(await verify(await signed(), now + 200), null, 'failure cached for at least 5 minutes');
    assert.equal(fetched.length, before);
    assert.ok(await verify(await signed({ created: now + 290 }), now + 301), 'retried after 5 minutes');
  }
  const now = nextTime();
  let calls = 0;
  directories.set('https://chatgpt.com', () => { calls++; return jwks()(); });
  const requests = await Promise.all(Array.from({ length: 25 }, () => signed()));
  const results = await Promise.all(requests.map((r) => verify(r, now)));
  assert.ok(results.every(Boolean));
  assert.equal(calls, 1);
  directories.set('https://chatgpt.com', jwks());
});

test('traffic: a verified signature counts as its signer’s agent whatever the User-Agent; a forged one falls back to the User-Agent', async () => {
  const posts = [];
  const server = createServer((req, res) => { let raw = ''; req.on('data', (c) => (raw += c)); req.on('end', () => { posts.push(JSON.parse(raw)); res.writeHead(202).end('{}'); }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    clock = Math.floor(Date.now() / 1000);
    const counter = trafficCounter({ key: 'lk_' + 'k'.repeat(32), site: 'docs.example.com', baseUrl: `http://127.0.0.1:${server.address().port}` });
    const kept = [];
    const ctx = { waitUntil: (p) => kept.push(p) };
    const browserUa = await signed();
    counter.record(browserUa, ctx);
    counter.observe(browserUa, new Response('', { status: 404 })); // before the check settles
    const forged = await signed({ ua: 'Mozilla/5.0 (compatible; ChatGPT-User/1.0; +https://openai.com/bot)', tamper: true, url: 'https://docs.example.com/forged' });
    counter.record(forged, ctx);
    const nobody = await signed({ tamper: true, url: 'https://docs.example.com/nobody' });
    counter.record(nobody, ctx);
    counter.observe(nobody, new Response('', { status: 200 }));
    assert.equal(kept.length, 3, 'each check kept alive by the platform');
    await Promise.all(kept);
    await counter.flush();
    assert.deepEqual(posts.flatMap((p) => p.rows).sort((a, b) => a.path.localeCompare(b.path)), [
      { path: '/forged', agent: 'ChatGPT-User', kind: 'user', count: 1 },
      { path: '/guide', agent: 'ChatGPT-Agent', kind: 'user', count: 1, verified: 1, outcomes: { not_found: 1 } },
    ]);
  } finally {
    server.close();
  }
});
