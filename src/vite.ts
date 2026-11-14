/**
 * Vite plugin: writes llms.txt (and llms-full.txt) from llms.ink into the build output, and with
 * `markdownPages: true` a Markdown version next to every built HTML page.
 *
 * @example
 * ```ts
 * // vite.config.ts
 * import { defineConfig } from 'vite';
 * import { llmsInk } from 'llms-ink/vite';
 *
 * export default defineConfig({ plugins: [llmsInk({ site: 'https://example.com', full: true })] });
 * ```
 *
 * @module
 */

import { resolve } from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';
import { llmsFilesWriter, type LlmsFilesOptions, type MarkdownPagesOptions } from './files.ts';

export type { LlmsFilesOptions, MarkdownPagesOptions };

/**
 * After `vite build` (not the dev server, not SSR builds), fetches llms.txt — and llms-full.txt with
 * `full: true` — for `site` and writes them into `build.outDir`. llms.ink reads the live site, so the files
 * describe the previous deploy. When llms.ink can't be reached it warns and keeps any existing file (e.g. one
 * copied from `public/`); `strict: true` fails the build instead. `markdownPages: true` converts each `.html` file
 * of this build (not the deploy) through `POST /api/v0/markdown` and writes `about.md` / `docs/index.md` next to it.
 */
export function llmsInk(options: LlmsFilesOptions): Plugin {
  const write = llmsFilesWriter(options);
  let config: ResolvedConfig;
  return {
    name: 'llms-ink',
    apply: 'build',
    configResolved(resolved) {
      config = resolved;
    },
    async closeBundle(error) {
      if (error) return;
      // Vite 6+ runs the hook once per environment; only the browser build is served as static files.
      const environment = this.environment;
      if (environment ? environment.name !== 'client' : config.build.ssr) return;
      const { outDir } = environment ? environment.config.build : config.build;
      await write(resolve(config.root, outDir), {
        info: (message) => config.logger.info(`[llms-ink] ${message}`),
        warn: (message) => config.logger.warn(`[llms-ink] ${message}`),
      });
    },
  };
}

export default llmsInk;
