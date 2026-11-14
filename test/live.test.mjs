// The client against production (https://llms.ink, or LLMS_INK_API). Runs under `node --test` and `bun test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LlmsInk, LlmsInkError, InvalidKeyError } from '../dist/index.js';

const ink = new LlmsInk({ key: process.env.LLMS_INK_KEY ?? '' });
const SLOW = { timeout: 300_000 };

test('llms: llmstxt.org', SLOW, async () => {
  const result = await ink.llms('llmstxt.org', { signal: AbortSignal.timeout(280_000) });
  assert.equal(result.mode, 'llms');
  assert.match(result.url, /llmstxt\.org/);
  assert.ok(result.text.startsWith('#'), result.text.slice(0, 80));
  assert.ok(result.tokens > 0);
});

test('check: llmstxt.org', SLOW, async () => {
  const result = await ink.check('llmstxt.org', { signal: AbortSignal.timeout(280_000) });
  assert.equal(result.found, true);
  assert.equal(typeof result.summary.errors, 'number');
});

test('stream: llmstxt.org ends with a result', SLOW, async () => {
  const types = [];
  let result;
  for await (const event of ink.stream('llmstxt.org', { signal: AbortSignal.timeout(280_000) })) {
    types.push(event.type);
    if (event.type === 'result') result = event.result;
  }
  assert.equal(types.at(-1), 'result');
  assert.ok(result.text.startsWith('#'));
});

test('checkText: parses posted text (skips until POST /api/v0/check is deployed)', SLOW, async (t) => {
  const text = '# Example\n\n> An example.\n\n## Docs\n\n- [A](/a): first\n';
  let result;
  try {
    result = await ink.checkText(text, { base: 'https://example.com/llms.txt', signal: AbortSignal.timeout(280_000) });
  } catch (err) {
    if (err instanceof LlmsInkError && (err.status === 404 || err.status === 405)) return t.skip(`not deployed (${err.status})`);
    throw err;
  }
  assert.equal(result.parsed.title, 'Example');
  assert.equal(result.parsed.summary, 'An example.');
  assert.equal(result.parsed.sections[0].links[0].url, 'https://example.com/a');
  assert.equal(result.parsed.sections[0].links[0].notes, 'first');
  assert.equal(result.llmsFull, null);
});

test('invalid key: 401 invalid_key', async () => {
  const err = await new LlmsInk({ key: 'lk_' + '0'.repeat(32) }).check('llmstxt.org').catch((e) => e);
  assert.ok(err instanceof InvalidKeyError, String(err));
  assert.equal(err.status, 401);
  assert.equal(err.code, 'invalid_key');
});
