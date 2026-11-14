// The Vite plugin and the Astro integration against a local stand-in for the API, writing into temp dirs.
// Runs under `node --test` and `bun test`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { llmsInk as vitePlugin } from '../dist/vite.js';
import astroIntegration from '../dist/astro.js';

/** Every query the stub saw. */
const seen = [];
const server = createServer((req, res) => {
  const q = Object.fromEntries(new URL(req.url, 'http://stub').searchParams);
  seen.push(q);
  if (q.url.includes('down.test')) {
    res.writeHead(503, { 'content-type': 'application/problem+json' });
    return res.end(JSON.stringify({ title: 'Unavailable', status: 503, code: 'unavailable', detail: 'Try later.' }));
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    url: q.url, kind: 'site', source: 'generated', mode: q.mode, title: 'T', text: `# ${q.url} ${q.mode}\n`,
    tokens: 5, pages: 1, model: null, cached: true, generatedAt: '2026-11-14T00:00:00.000Z',
  }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const dirs = [];
after(async () => {
  server.closeAllConnections();
  server.close();
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempRoot() {
  const dir = await mkdtemp(join(tmpdir(), 'llms-ink-test-'));
  dirs.push(dir);
  return dir;
}

function logger() {
  const lines = { info: [], warn: [] };
  return { lines, info: (m) => lines.info.push(m), warn: (m) => lines.warn.push(m) };
}

/** Runs the plugin the way `vite build` does: configResolved, then closeBundle per environment. */
async function viteBuild(options, { environments = ['client'], existing } = {}) {
  const root = await tempRoot();
  const outDir = join(root, 'dist');
  await mkdir(outDir, { recursive: true });
  if (existing) await writeFile(join(outDir, 'llms.txt'), existing);
  const log = logger();
  const plugin = vitePlugin({ baseUrl, key: '', ...options });
  assert.equal(plugin.name, 'llms-ink');
  assert.equal(plugin.apply, 'build');
  plugin.configResolved({ root, build: { outDir: 'dist', ssr: false }, logger: log });
  for (const name of environments) {
    await plugin.closeBundle.call({ environment: { name, config: { build: { outDir: name === 'client' ? 'dist' : 'dist/server' } } } });
  }
  return { outDir, log, plugin };
}

test('vite: writes llms.txt and llms-full.txt into outDir, client environment only', async () => {
  const before = seen.length;
  const { outDir, log } = await viteBuild({ site: 'https://ok.test', full: true }, { environments: ['client', 'ssr'] });
  assert.equal(await readFile(join(outDir, 'llms.txt'), 'utf8'), '# https://ok.test llms\n');
  assert.equal(await readFile(join(outDir, 'llms-full.txt'), 'utf8'), '# https://ok.test full\n');
  assert.equal(seen.length - before, 2, 'one request per file; the ssr environment is skipped');
  assert.deepEqual(seen.slice(before).map((q) => q.mode).sort(), ['full', 'llms']);
  assert.equal(seen.at(-1).native, undefined, 'native is on by default');
  assert.equal(log.lines.info.length, 2);
  assert.match(log.lines.info[0], /^\[llms-ink\] Wrote llms/);
  assert.deepEqual(log.lines.warn, []);
});

test('vite: without full only llms.txt; native false sends native=0', async () => {
  const { outDir } = await viteBuild({ site: 'https://ok.test', native: false });
  assert.equal(seen.at(-1).native, '0');
  assert.equal(seen.at(-1).mode, 'llms');
  await assert.rejects(readFile(join(outDir, 'llms-full.txt')), { code: 'ENOENT' });
});

test('vite: Vite 5 (no this.environment) writes, SSR builds are skipped', async () => {
  const root = await tempRoot();
  for (const ssr of [true, false]) {
    const plugin = vitePlugin({ site: 'https://ok.test', baseUrl });
    plugin.configResolved({ root, build: { outDir: ssr ? 'server' : 'client', ssr }, logger: logger() });
    await plugin.closeBundle.call({});
  }
  await assert.rejects(readFile(join(root, 'server', 'llms.txt')), { code: 'ENOENT' });
  assert.equal(await readFile(join(root, 'client', 'llms.txt'), 'utf8'), '# https://ok.test llms\n');
});

test('vite: a failed build (closeBundle error) writes nothing', async () => {
  const root = await tempRoot();
  const before = seen.length;
  const plugin = vitePlugin({ site: 'https://ok.test', baseUrl });
  plugin.configResolved({ root, build: { outDir: 'dist' }, logger: logger() });
  await plugin.closeBundle.call({}, new Error('build failed'));
  assert.equal(seen.length, before);
});

test('vite: llms.ink failing warns and keeps the existing file', async () => {
  const { outDir, log } = await viteBuild({ site: 'https://down.test', full: true }, { existing: '# Old\n' });
  assert.equal(await readFile(join(outDir, 'llms.txt'), 'utf8'), '# Old\n');
  await assert.rejects(readFile(join(outDir, 'llms-full.txt')), { code: 'ENOENT' });
  assert.equal(log.lines.warn.length, 2);
  assert.match(log.lines.warn.join('\n'), /llms\.txt for https:\/\/down\.test: Try later\. \(kept the existing file\)/);
  assert.match(log.lines.warn.join('\n'), /llms-full\.txt .*\(none written\)/);
});

test('vite: strict fails the build', async () => {
  await assert.rejects(viteBuild({ site: 'https://down.test', strict: true }), /Couldn't get llms\.txt for https:\/\/down\.test: Try later\./);
});

test('vite: watch rebuilds reuse a good fetch and retry a failed one', async () => {
  const root = await tempRoot();
  const plugin = vitePlugin({ site: 'https://ok.test', baseUrl });
  plugin.configResolved({ root, build: { outDir: 'dist' }, logger: logger() });
  const before = seen.length;
  await plugin.closeBundle.call({});
  await plugin.closeBundle.call({});
  assert.equal(seen.length - before, 1);

  const failing = vitePlugin({ site: 'https://down.test', baseUrl });
  failing.configResolved({ root, build: { outDir: 'dist' }, logger: logger() });
  await failing.closeBundle.call({});
  await failing.closeBundle.call({});
  assert.equal(seen.length - before, 3);
});

test('astro: site defaults to config.site + base; writes into the build dir', async () => {
  const dir = await tempRoot();
  const integration = astroIntegration({ baseUrl, full: true });
  assert.equal(integration.name, 'llms-ink');
  const log = logger();
  await integration.hooks['astro:config:done']({ config: { site: 'https://ok.test', base: '/docs' } });
  await integration.hooks['astro:build:done']({ dir: pathToFileURL(`${dir}/`), logger: log, pages: [] });
  assert.equal(await readFile(join(dir, 'llms.txt'), 'utf8'), '# https://ok.test/docs llms\n');
  assert.equal(await readFile(join(dir, 'llms-full.txt'), 'utf8'), '# https://ok.test/docs full\n');
  assert.match(log.lines.info[0], /^Wrote llms\.txt for https:\/\/ok\.test\/docs \(generated, ~5 tokens\)\.$/);
});

test('astro: an explicit site wins; no site at all warns (strict throws)', async () => {
  const dir = await tempRoot();
  const explicit = astroIntegration({ baseUrl, site: 'https://other.test' });
  await explicit.hooks['astro:config:done']({ config: { site: 'https://ok.test', base: '/' } });
  await explicit.hooks['astro:build:done']({ dir: pathToFileURL(`${dir}/`), logger: logger(), pages: [] });
  assert.equal(await readFile(join(dir, 'llms.txt'), 'utf8'), '# https://other.test llms\n');

  const log = logger();
  const none = astroIntegration({ baseUrl });
  await none.hooks['astro:config:done']({ config: { base: '/' } });
  await none.hooks['astro:build:done']({ dir: pathToFileURL(`${dir}/`), logger: log, pages: [] });
  assert.match(log.lines.warn[0], /No `site` set/);

  const strict = astroIntegration({ baseUrl, strict: true });
  await strict.hooks['astro:config:done']({ config: { base: '/' } });
  await assert.rejects(strict.hooks['astro:build:done']({ dir: pathToFileURL(`${dir}/`), logger: logger(), pages: [] }), /No `site` set/);
});

test('astro: llms.ink failing warns and keeps the existing file', async () => {
  const dir = await tempRoot();
  await writeFile(join(dir, 'llms.txt'), '# Old\n');
  const log = logger();
  const integration = astroIntegration({ baseUrl, site: 'https://down.test' });
  await integration.hooks['astro:config:done']({ config: { site: 'https://ok.test', base: '/' } });
  await integration.hooks['astro:build:done']({ dir: pathToFileURL(`${dir}/`), logger: log, pages: [] });
  assert.equal(await readFile(join(dir, 'llms.txt'), 'utf8'), '# Old\n');
  assert.match(log.lines.warn[0], /kept the existing file/);
});
