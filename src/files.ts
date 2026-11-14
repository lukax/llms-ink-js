/**
 * Shared by the Vite plugin and the Astro integration: fetch llms.txt (and llms-full.txt) for a site and write
 * them into a build's output directory.
 *
 * @module
 */

import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LlmsInk, type Mode } from './index.ts';

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
  /** Fail the build when a file can't be fetched. Default `false`: warn and keep any existing file. */
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

/**
 * A writer that fetches the files once and writes them into `dir` on every call (watch builds call it again;
 * a failed fetch is retried on the next call).
 */
export function llmsFilesWriter(options: LlmsFilesOptions): (dir: string, log: Log) => Promise<void> {
  let fetched: Promise<Fetched[]> | undefined;
  return async (dir, log) => {
    const { site, strict = false } = options;
    if (!site) {
      const message = 'No `site` set: llms.txt not written.';
      if (strict) throw new Error(message);
      return log.warn(message);
    }
    fetched ??= fetchFiles(options);
    const results = await fetched;
    const failures: string[] = [];
    for (const result of results) {
      const path = join(dir, result.name);
      if ('text' in result) {
        await mkdir(dir, { recursive: true });
        await writeFile(path, result.text);
        log.info(`Wrote ${result.name} for ${site} (${result.source}, ~${result.tokens} tokens).`);
        continue;
      }
      const reason = result.error instanceof Error ? result.error.message : String(result.error);
      const kept = await access(path).then(() => 'kept the existing file', () => 'none written');
      failures.push(`Couldn't get ${result.name} for ${site}: ${reason} (${kept}).`);
    }
    if (failures.length) fetched = undefined;
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
