// llms-ink/ai: Vercel AI SDK tools against a mocked fetch. Runs under `node --test` and `bun test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateText, stepCountIs } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { LlmsInk, InvalidKeyError } from '../dist/index.js';
import { llmsInkTools, DEFAULT_MAX_CHARS } from '../dist/ai.js';

const RESULT = {
  url: 'https://example.com/', kind: 'site', source: 'generated', mode: 'llms', title: 'Example',
  text: '# Example\n\n> An example.\n', tokens: 6, pages: 1, model: null, cached: true, generatedAt: '2026-11-14T00:00:00.000Z',
};
const CHECK = {
  site: 'https://example.com', url: 'https://example.com/llms.txt', found: true, status: 200, title: 'Example',
  tokens: 3, sections: 1, links: { total: 2, checked: 2, broken: [{ url: 'https://example.com/gone', status: 404 }] },
  llmsFull: false, summary: { errors: 1, warnings: 0 }, checkedAt: '2026-11-14T00:00:00.000Z',
  issues: [{ level: 'error', code: 'broken_link', line: 6, message: 'https://example.com/gone answered 404.' }],
  parsed: { title: 'Example', summary: null, details: null, sections: [{ name: 'Docs', optional: false, text: null, links: [{}, {}] }] },
};
const REPORT = {
  url: 'https://example.com/', site: 'https://example.com', checkedAt: '2026-11-14T00:00:00.000Z',
  summary: { pass: 1, warn: 0, fail: 1, info: 0 },
  sections: [{
    id: 'access', title: 'Access', checks: [
      { id: 'bots-search', status: 'fail', title: 'Search bots', detail: 'OAI-SearchBot is disallowed.', evidence: 'User-agent: OAI-SearchBot\nDisallow: /',
        fix: { kind: 'robots', summary: 'Allow OAI-SearchBot.', patch: { file: '/robots.txt', content: 'User-agent: OAI-SearchBot\nAllow: /' } } },
      { id: 'firewall', status: 'pass', title: 'Firewall', detail: 'Bots get the page.' },
    ],
  }],
};

const problem = (status, code, detail, headers = {}) =>
  new Response(JSON.stringify({ type: 'https://llms.ink/docs/#errors', title: 'T', status, code, detail }), {
    status, headers: { 'content-type': 'application/problem+json', ...headers },
  });
const json = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

/** A client whose fetch answers like llms.ink and records each request. */
function stub(overrides = {}) {
  const seen = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    const query = Object.fromEntries(url.searchParams);
    seen.push({ method: init.method ?? 'GET', path: url.pathname, query, body: init.body, headers: init.headers, signal: init.signal });
    if (init.headers?.authorization === 'Bearer lk_bad') return problem(401, 'invalid_key', 'Unknown key.');
    if (query.url === 'rate.test') return problem(429, 'rate_limited', 'Slow down.', { 'retry-after': '42' });
    if (query.url === 'quota.test') return problem(429, 'quota_exceeded', 'Quota used.', { 'retry-after': '3600' });
    if (query.url === 'bad.test') return problem(422, 'unprocessable', 'Nothing to read on this page.');
    if (query.url === 'down.test') throw new TypeError('fetch failed');
    if (url.pathname === '/api/v0/llms') return json({ ...RESULT, mode: query.mode, text: overrides.text ?? RESULT.text });
    if (url.pathname === '/api/v0/check') return json(init.method === 'POST' ? { ...CHECK, site: null, url: null, llmsFull: null } : CHECK);
    if (url.pathname === '/api/v0/report') return json(REPORT);
    return problem(404, 'not_found', 'No such endpoint.');
  };
  return { seen, client: new LlmsInk({ baseUrl: 'https://stub.test', key: overrides.key ?? '', fetch }) };
}

const call = { toolCallId: 'call-1', messages: [] };

test('all four tools by default, with descriptions and input schemas', () => {
  const tools = llmsInkTools({ client: stub().client });
  assert.deepEqual(Object.keys(tools), ['llmsTxt', 'llmsFullTxt', 'checkLlmsTxt', 'agentView']);
  for (const t of Object.values(tools)) {
    assert.equal(typeof t.description, 'string');
    assert.ok(t.inputSchema);
    assert.equal(typeof t.execute, 'function');
  }
  assert.match(tools.llmsFullTxt.description, /prefer llmsTxt/);
  assert.equal(DEFAULT_MAX_CHARS, 40000);
});

test('include picks tools; unknown names and a bad maxChars throw', () => {
  const tools = llmsInkTools({ client: stub().client, include: ['llmsTxt', 'agentView'] });
  assert.deepEqual(Object.keys(tools), ['llmsTxt', 'agentView']);
  assert.deepEqual(Object.keys(llmsInkTools({ client: stub().client, include: [] })), []);
  assert.throws(() => llmsInkTools({ include: ['fetch'] }), /Unknown llms.ink tool "fetch"/);
  assert.throws(() => llmsInkTools({ maxChars: 0 }), TypeError);
});

test('client options build a client', async () => {
  const urls = [];
  const fetch = async (input) => { urls.push(String(input)); return json(RESULT); };
  const tools = llmsInkTools({ client: { baseUrl: 'https://other.test/', key: '', fetch } });
  assert.equal((await tools.llmsTxt.execute({ url: 'example.com' }, call)).title, 'Example');
  assert.deepEqual(urls, ['https://other.test/api/v0/llms?url=example.com&mode=llms']);
});

test('llmsTxt and llmsFullTxt: modes, fresh, abort signal and the structured result', async () => {
  const { client, seen } = stub();
  const tools = llmsInkTools({ client });
  const signal = new AbortController().signal;
  const out = await tools.llmsTxt.execute({ url: 'example.com' }, { ...call, abortSignal: signal });
  assert.deepEqual(out, {
    url: 'https://example.com/', title: 'Example', kind: 'site', source: 'generated', tokens: 6, pages: 1, cached: true,
    text: RESULT.text, truncated: false,
  });
  assert.deepEqual(seen.at(-1).query, { url: 'example.com', mode: 'llms' });
  assert.equal(seen.at(-1).signal, signal);
  await tools.llmsFullTxt.execute({ url: 'example.com', fresh: true }, call);
  assert.deepEqual(seen.at(-1).query, { url: 'example.com', mode: 'full', fresh: '1' });
});

test('long text is cut to maxChars with a note', async () => {
  const text = 'line of text\n'.repeat(100); // 1300 characters
  const tools = llmsInkTools({ client: stub({ text }).client, maxChars: 500 });
  const out = await tools.llmsFullTxt.execute({ url: 'example.com' }, call);
  assert.equal(out.truncated, true);
  const [kept, note] = out.text.split('\n\n[Truncated: ');
  assert.ok(kept.length <= 500 && kept.length > 450, `kept ${kept.length}`);
  assert.ok(text.startsWith(kept));
  assert.ok(kept.endsWith('text'), 'cut at a line break');
  assert.match(note, new RegExp(`^showing ${kept.length} of 1300 characters\\. Call llmsTxt`));
  assert.equal((await llmsInkTools({ client: stub({ text }).client, maxChars: 1300 }).llmsFullTxt.execute({ url: 'x' }, call)).truncated, false);
});

test('the cut never splits a surrogate pair', async () => {
  const text = 'a'.repeat(9) + '😀'.repeat(10);
  const out = await llmsInkTools({ client: stub({ text }).client, maxChars: 10 }).llmsTxt.execute({ url: 'x' }, call);
  assert.ok(out.text.startsWith('a'.repeat(9) + '\n\n[Truncated: showing 9 of 29'));
});

test('checkLlmsTxt: url, or text with base and links, as a short report', async () => {
  const { client, seen } = stub();
  const tools = llmsInkTools({ client });
  const out = await tools.checkLlmsTxt.execute({ url: 'example.com' }, call);
  assert.equal(out.found, true);
  assert.deepEqual(out.summary, { errors: 1, warnings: 0 });
  assert.equal(out.truncated, false);
  assert.match(out.text, /^https:\/\/example.com\/llms.txt: 1 error, 0 warnings · 1 section · 2 links \(2 checked, 1 broken\)/);
  assert.match(out.text, /Sections: Docs \(2 links\)/);
  assert.match(out.text, /- error \(line 6\): https:\/\/example.com\/gone answered 404./);
  assert.deepEqual(seen.at(-1).query, { url: 'example.com' });

  await tools.checkLlmsTxt.execute({ text: '# Draft\n', base: 'example.com', links: true }, call);
  assert.equal(seen.at(-1).method, 'POST');
  assert.equal(seen.at(-1).body, '# Draft\n');
  assert.deepEqual(seen.at(-1).query, { base: 'example.com', links: '1' });
});

test('checkLlmsTxt: url and text together, or neither, is an error result', async () => {
  const { client, seen } = stub();
  const tools = llmsInkTools({ client });
  for (const input of [{}, { url: 'example.com', text: '# x' }]) {
    assert.deepEqual(await tools.checkLlmsTxt.execute(input, call), {
      error: 'Pass url (a published llms.txt) or text (the file itself), not both.', code: 'invalid_request',
    });
  }
  assert.equal(seen.length, 0);
});

test('agentView: the report as text with fixes', async () => {
  const { client, seen } = stub();
  const out = await llmsInkTools({ client }).agentView.execute({ url: 'example.com' }, call);
  assert.equal(seen.at(-1).path, '/api/v0/report');
  assert.deepEqual(seen.at(-1).query, { url: 'example.com' });
  assert.equal(out.url, 'https://example.com/');
  assert.deepEqual(out.summary, REPORT.summary);
  assert.equal(out.text, [
    'https://example.com/: 1 fail, 0 warn, 1 pass, 0 info',
    '',
    '## Access',
    '✕ fail · Search bots: OAI-SearchBot is disallowed.',
    '    User-agent: OAI-SearchBot',
    '    Disallow: /',
    '  fix (robots): Allow OAI-SearchBot. [patch for /robots.txt]',
    '✓ pass · Firewall: Bots get the page.',
  ].join('\n'));
});

test('API errors come back as results the model can read', async () => {
  const tools = llmsInkTools({ client: stub().client });
  assert.deepEqual(await tools.llmsTxt.execute({ url: 'rate.test' }, call), {
    error: 'llms.ink rate limit: wait 42 seconds, then try again.', code: 'rate_limited', retryAfter: 42,
  });
  assert.deepEqual(await tools.agentView.execute({ url: 'quota.test' }, call), {
    error: 'llms.ink daily quota of new links is used up; it resets in 3600 seconds (midnight UTC). Cached links still work.',
    code: 'quota_exceeded', retryAfter: 3600,
  });
  assert.deepEqual(await tools.llmsFullTxt.execute({ url: 'bad.test' }, call), {
    error: 'llms.ink: Nothing to read on this page.', code: 'unprocessable',
  });
  const down = await tools.checkLlmsTxt.execute({ url: 'down.test' }, call);
  assert.match(down.error, /^llms.ink: Couldn't reach https:\/\/stub.test: fetch failed/);
  assert.equal(down.code, undefined);
});

test('an invalid key and aborts throw', async () => {
  const tools = llmsInkTools({ client: stub({ key: 'lk_bad' }).client });
  await assert.rejects(tools.llmsTxt.execute({ url: 'example.com' }, call), InvalidKeyError);
  const aborting = new LlmsInk({ baseUrl: 'https://stub.test', key: '', fetch: async () => { throw new DOMException('Aborted', 'AbortError'); } });
  await assert.rejects(llmsInkTools({ client: aborting }).llmsTxt.execute({ url: 'example.com' }, call), { name: 'AbortError' });
});

test('generateText: a mock model calls llmsTxt and gets its result back', async () => {
  const { client, seen } = stub();
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
  const model = new MockLanguageModelV4({
    doGenerate: [
      {
        content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'llmsTxt', input: JSON.stringify({ url: 'example.com' }) }],
        finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage, warnings: [],
      },
      { content: [{ type: 'text', text: 'Example is an example.' }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] },
    ],
  });
  const result = await generateText({ model, tools: llmsInkTools({ client }), stopWhen: stepCountIs(3), prompt: 'What is example.com?' });
  assert.equal(result.text, 'Example is an example.');
  assert.deepEqual(seen.map((r) => r.query), [{ url: 'example.com', mode: 'llms' }]);
  const [first] = result.steps;
  assert.equal(first.toolResults.length, 1);
  assert.equal(first.toolResults[0].toolName, 'llmsTxt');
  assert.equal(first.toolResults[0].output.title, 'Example');
  // The model saw the tools and, on the second call, the tool result.
  const [call1, call2] = model.doGenerateCalls;
  assert.deepEqual(call1.tools.map((t) => t.name), ['llmsTxt', 'llmsFullTxt', 'checkLlmsTxt', 'agentView']);
  const toolMessage = call2.prompt.find((m) => m.role === 'tool');
  assert.equal(toolMessage.content[0].output.value.text, RESULT.text);
});
