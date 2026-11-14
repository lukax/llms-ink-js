/**
 * Astro integration: writes llms.txt (and llms-full.txt) from llms.ink into the build output, and with
 * `markdownPages: true` a Markdown version next to every built HTML page.
 *
 * @example
 * ```ts
 * // astro.config.mjs
 * import { defineConfig } from 'astro/config';
 * import llmsInk from 'llms-ink/astro';
 *
 * export default defineConfig({ site: 'https://example.com', integrations: [llmsInk({ full: true })] });
 * ```
 *
 * @module
 */

import { fileURLToPath } from 'node:url';
import type { AstroIntegration } from 'astro';
import { llmsFilesWriter, type LlmsFilesOptions, type MarkdownPagesOptions } from './files.ts';

export type { MarkdownPagesOptions };

/** {@link LlmsFilesOptions} with `site` optional: it defaults to Astro's `site` (plus `base`). */
export type LlmsInkAstroOptions = Omit<LlmsFilesOptions, 'site'> & { site?: string };

/**
 * After `astro build`, fetches llms.txt — and llms-full.txt with `full: true` — for `site` (default: the
 * `site` and `base` of the Astro config) and writes them into the static output directory. llms.ink reads the
 * live site, so the files describe the previous deploy. When llms.ink can't be reached it warns and keeps any
 * existing file (e.g. one copied from `public/`); `strict: true` fails the build instead. `markdownPages: true`
 * converts each prerendered `.html` page of this build through `POST /api/v0/markdown` and writes `about.md` /
 * `docs/index.md` next to it; page URLs come from `site`.
 */
export function llmsInk(options: LlmsInkAstroOptions = {}): AstroIntegration {
  const settings: LlmsFilesOptions = { ...options, site: options.site ?? '' };
  const write = llmsFilesWriter(settings);
  return {
    name: 'llms-ink',
    hooks: {
      'astro:config:done': ({ config }) => {
        if (!settings.site && config.site) settings.site = new URL(config.base, config.site).href;
      },
      'astro:build:done': async ({ dir, logger }) => {
        await write(fileURLToPath(dir), logger);
      },
    },
  };
}

export default llmsInk;
