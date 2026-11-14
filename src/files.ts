/**
 * Shared by the Vite plugin and the Astro integration: fetch llms.txt (and llms-full.txt) for a site and write
 * them into a build's output directory; with `markdownPages`, write a `.md` version next to every built HTML page.
 *
 * @module
 */

import { access, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { LlmsInk, LlmsInkError, type Mode } from './index.ts';

/** `markdownPages` settings beyond `true`. */
export interface MarkdownPagesOptions {
  /** Pages converted at once. Default 4. */
  concurrency?: number;
  /** Pages to skip, matched against the page path (`/docs/`, `/about`). Default: `/404` and `/500` pages. */
  exclude?: RegExp;
}

/** Options for the Vite plugin and the Astro integration. */
export interface LlmsFilesOptions {
  /** The deployed site to describe, e.g. `https://example.com`. llms.ink reads the live site. */
  site: string;
  /** Also write llms-full.txt (the content of up to 20 pages). Default `false`. */
  full?: boolean;
  /** API key (`lk_…`). Defaults to the `LLMS_INK_KEY` environment variable; anonymous without one. */
  key?: string;
  /**
   * Default `true`: when the live site publishes its own llms.txt, that file is used as is, unless it's one
   * llms.ink generated before (it carries the llms.ink credit line), which is regenerated. `false` always
   * generates (`native=0`).
   */
  native?: boolean;
  /**
   * Write a Markdown version of every HTML page of this build next to it (`about.html` → `about.md`,
   * `docs/index.html` → `docs/index.md`), converted by llms.ink from the local output (`POST /api/v0/markdown`):
   * chrome and hidden-instruction text dropped, relative links resolved against `site`. Existing `.md` files are
   * never overwritten; pages over 5 MB are skipped. Default `false`.
   */
  markdownPages?: boolean | MarkdownPagesOptions;
  /** Fail the build when a file can't be fetched or a page can't be converted. Default `false`: warn and go on. */
  strict?: boolean;
  /** Milliseconds to wait for llms.ink per file. Default 300000 (building a big site can take minutes). */
  timeout?: number;
  /** Defaults to the `LLMS_INK_API` environment variable, else https://llms.ink. */
  baseUrl?: string;
}

/** Where messages go: Vite's or Astro's logger. */
export interface Log {
  info(message: string): void;
  warn(message: string): void;
}

type Fetched = { name: string; text: string; tokens: number; source: string } | { name: string; error: unknown };

const FILES: Array<[name: string, mode: Mode]> = [['llms.txt', 'llms'], ['llms-full.txt', 'full']];

/** The endpoint's body limit. */
export const MAX_PAGE_BYTES = 5_000_000;
const PAGE_TIMEOUT = 60_000;
/** Tries per page when llms.ink says to slow down (429 with Retry-After). */
const RATE_TRIES = 4;
const DEFAULT_EXCLUDE = /^\/(404|500)(\.html|\/)?$/;

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * A writer that fetches the files once and writes them into `dir` on every call (watch builds call it again;
 * a failed fetch is retried on the next call). Markdown pages are converted on every call: they describe this build.
 */
export function llmsFilesWriter(options: LlmsFilesOptions): (dir: string, log: Log) => Promise<void> {
  let fetched: Promise<Fetched[]> | undefined;
  return async (dir, log) => {
    const { site, strict = false } = options;
    const failures: string[] = [];
    if (!site) failures.push('No `site` set: llms.txt not written.');
    else {
      fetched ??= fetchFiles(options);
      for (const result of await fetched) {
        const path = join(dir, result.name);
        if ('text' in result) {
          await mkdir(dir, { recursive: true });
          await writeFile(path, result.text);
          log.info(`Wrote ${result.name} for ${site} (${result.source}, ~${result.tokens} tokens).`);
          continue;
        }
        const kept = await access(path).then(() => 'kept the existing file', () => 'none written');
        failures.push(`Couldn't get ${result.name} for ${site}: ${reason(result.error)} (${kept}).`);
      }
      if (failures.length) fetched = undefined;
    }
    if (options.markdownPages) failures.push(...(await writeMarkdownPages(dir, options, log)));
    if (strict && failures.length) throw new Error(failures.join(' '));
    for (const message of failures) log.warn(message);
  };
}

async function fetchFiles({ site, full, key, native = true, timeout = 300_000, baseUrl }: LlmsFilesOptions): Promise<Fetched[]> {
  const ink = new LlmsInk({ key, baseUrl });
  const files = full ? FILES : FILES.slice(0, 1);
  return Promise.all(
    files.map(([name, mode]) =>
      ink.llms(site, { mode, native, signal: AbortSignal.timeout(timeout) }).then(
        ({ text, tokens, source }): Fetched => ({ name, text, tokens, source }),
        (error: unknown): Fetched => ({ name, error }),
      ),
    ),
  );
}

/** Every `.html` file under `dir`, as paths relative to it with `/` separators, sorted. Symlinks aren't followed. */
async function htmlFiles(dir: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(join(dir, prefix), { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.map((e) => {
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) return htmlFiles(dir, path);
      return e.isFile() && e.name.endsWith('.html') ? [path] : [];
    }),
  );
  return nested.flat().sort();
}

/** `docs/index.html` → `/docs/`, `about.html` → `/about`, `index.html` → `/`. */
export function pagePath(file: string): string {
  const path = `/${file.replace(/\.html$/, '')}`;
  return path.endsWith('/index') ? path.slice(0, -'index'.length) : path;
}

/**
 * Converts each HTML page of `dir` through llms.ink and writes `<page>.md` next to it. Returns the failure messages
 * (the caller warns or, with `strict`, fails the build).
 */
async function writeMarkdownPages(dir: string, options: LlmsFilesOptions, log: Log): Promise<string[]> {
  const settings = typeof options.markdownPages === 'object' ? options.markdownPages : {};
  const exclude = settings.exclude ?? DEFAULT_EXCLUDE;
  const concurrency = Math.max(1, Math.floor(settings.concurrency ?? 4));
  const ink = new LlmsInk({ key: options.key, baseUrl: options.baseUrl });
  const site = options.site ? new URL(options.site.endsWith('/') ? options.site : `${options.site}/`) : null;
  const pages = (await htmlFiles(dir)).filter((file) => !exclude.test(pagePath(file)));
  const failures: string[] = [];
  let written = 0;
  let skipped = 0;

  const convert = async (file: string) => {
    const target = join(dir, file.replace(/\.html$/, '.md'));
    const md = file.replace(/\.html$/, '.md');
    if (await access(target).then(() => true, () => false)) {
      skipped++;
      return log.info(`Kept ${md}: it already exists.`);
    }
    const source = join(dir, file);
    if ((await stat(source)).size > MAX_PAGE_BYTES) {
      skipped++;
      return log.warn(`Skipped ${file}: over ${MAX_PAGE_BYTES.toLocaleString('en-US')} bytes.`);
    }
    const html = await readFile(source, 'utf8');
    // Page URL under `site` (its path included: Astro's `base`).
    const url = site ? new URL(pagePath(file).slice(1), site).href : undefined;
    for (let attempt = 1; ; attempt++) {
      try {
        const text = await ink.markdown(html, { url, signal: AbortSignal.timeout(PAGE_TIMEOUT) });
        await writeFile(target, text);
        written++;
        return;
      } catch (error) {
        const limited = error instanceof LlmsInkError && error.status === 429 && error.code === 'rate_limited';
        if (limited && attempt < RATE_TRIES) {
          await wait(Math.min(error.retryAfter ?? 10, 60) * 1000);
          continue;
        }
        failures.push(`Couldn't convert ${file} to Markdown: ${reason(error).replace(/\.$/, '')}.`);
        return;
      }
    }
  };

  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, pages.length) }, async () => {
    while (next < pages.length) await convert(pages[next++]);
  }));
  log.info(`Wrote ${written} Markdown page${written === 1 ? '' : 's'}${skipped ? ` (${skipped} skipped)` : ''}${failures.length ? `; ${failures.length} failed` : ''}.`);
  return failures;
}
