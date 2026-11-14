/**
 * llms.ink as Vercel AI SDK tools (`ai` 5 and later, with `zod`):
 *
 * ```ts
 * import { generateText, stepCountIs } from 'ai';
 * import { llmsInkTools } from 'llms-ink/ai';
 *
 * const { text } = await generateText({
 *   model: 'openai/gpt-5',
 *   tools: llmsInkTools(),
 *   stopWhen: stepCountIs(5),
 *   prompt: 'How do I paginate with the Stripe API? Read docs.stripe.com first.',
 * });
 * ```
 *
 * Results are cut to `maxChars` with a note saying so. API errors come back as `{ error, code, retryAfter? }`
 * for the model to read; an invalid API key throws.
 *
 * @module
 */

import { tool, type Tool } from 'ai';
import { z } from 'zod';
import {
  InvalidKeyError,
  LlmsInk,
  LlmsInkError,
  QuotaExceededError,
  RateLimitedError,
  type CheckResult,
  type Kind,
  type LlmsInkOptions,
  type ReportResult,
  type Source,
} from './index.ts';

/** The tools {@link llmsInkTools} can return, by name. */
export type LlmsInkToolName = 'llmsTxt' | 'llmsFullTxt' | 'checkLlmsTxt' | 'agentView';

/** Options for {@link llmsInkTools}. */
export interface LlmsInkToolsOptions<K extends LlmsInkToolName = LlmsInkToolName> {
  /** A client, or options for a new one (`key` defaults to `LLMS_INK_KEY`). */
  client?: LlmsInk | LlmsInkOptions;
  /** Longest text a tool returns, in characters; longer text is cut and says so. Default 40000. */
  maxChars?: number;
  /** Only these tools. Default: all four. */
  include?: readonly K[];
}

/** Input of `llmsTxt` and `llmsFullTxt`. */
export interface LinkInput {
  url: string;
  fresh?: boolean;
}

/** Input of `checkLlmsTxt`: `url`, or `text` with optional `base` and `links`. */
export interface CheckInput {
  url?: string;
  text?: string;
  base?: string;
  links?: boolean;
}

/** Input of `agentView`. */
export interface AgentViewInput {
  url: string;
}

/** What a tool returns instead of throwing when llms.ink answers with an error or can't be reached. */
export interface LlmsInkToolError {
  /** A sentence for the model, e.g. "llms.ink rate limit: wait 42 seconds, then try again." */
  error: string;
  /** The API's error code (`rate_limited`, `invalid_url`…); absent when llms.ink couldn't be reached. */
  code?: string;
  /** Seconds to wait before trying again, when llms.ink said so. */
  retryAfter?: number;
}

/** `llmsTxt` / `llmsFullTxt` result. */
export interface LlmsTextOutput {
  url: string;
  title: string;
  kind: Kind;
  source: Source;
  /** Approximate tokens of the whole file, before any cut. */
  tokens: number;
  /** Links in llms.txt, or pages inlined in llms-full.txt. */
  pages: number;
  cached: boolean;
  text: string;
  /** `text` was cut to `maxChars`; it ends with a note saying so. */
  truncated: boolean;
}

/** `checkLlmsTxt` result: `text` is a short report with each issue and its line. */
export interface CheckOutput {
  url: string | null;
  site: string | null;
  found: boolean;
  summary: { errors: number; warnings: number };
  text: string;
  truncated: boolean;
}

/** `agentView` result: `text` lists every check with its status, evidence and fix. */
export interface AgentViewOutput {
  url: string;
  site: string;
  summary: { pass: number; warn: number; fail: number; info: number };
  text: string;
  truncated: boolean;
}

/** Every tool, by name. */
export interface LlmsInkTools {
  llmsTxt: Tool<LinkInput, LlmsTextOutput | LlmsInkToolError>;
  llmsFullTxt: Tool<LinkInput, LlmsTextOutput | LlmsInkToolError>;
  checkLlmsTxt: Tool<CheckInput, CheckOutput | LlmsInkToolError>;
  agentView: Tool<AgentViewInput, AgentViewOutput | LlmsInkToolError>;
}

export const DEFAULT_MAX_CHARS = 40_000;

const NAMES: readonly LlmsInkToolName[] = ['llmsTxt', 'llmsFullTxt', 'checkLlmsTxt', 'agentView'];

/**
 * llms.ink tools for `generateText` / `streamText` / agents of the Vercel AI SDK: `llmsTxt`, `llmsFullTxt`,
 * `checkLlmsTxt` and `agentView`, or the ones in `include`.
 */
export function llmsInkTools<K extends LlmsInkToolName = LlmsInkToolName>(options: LlmsInkToolsOptions<K> = {}): Pick<LlmsInkTools, K> {
  const max = options.maxChars ?? DEFAULT_MAX_CHARS;
  if (!Number.isInteger(max) || max < 1) throw new TypeError(`maxChars must be a positive integer, not ${max}`);
  const include: readonly LlmsInkToolName[] = options.include ?? NAMES;
  for (const name of include) {
    if (!NAMES.includes(name)) throw new TypeError(`Unknown llms.ink tool ${JSON.stringify(name)}: use ${NAMES.join(', ')}.`);
  }
  const given = options.client;
  const ink = given && typeof (given as LlmsInk).llms === 'function' ? (given as LlmsInk) : new LlmsInk(given as LlmsInkOptions | undefined);

  const llmsTool = (mode: 'llms' | 'full', description: string, hint: string): Tool<LinkInput, LlmsTextOutput | LlmsInkToolError> =>
    tool({
      description,
      inputSchema: z.object({
        url: z.string().describe('Any public http(s) link, e.g. "docs.stripe.com/payments", "github.com/honojs/hono", a PDF or a video URL. The scheme is optional.'),
        fresh: z.boolean().optional().describe('Ignore the 24h cache and rebuild. Default false.'),
      }),
      execute: (input: LinkInput, { abortSignal }) =>
        attempt(async (): Promise<LlmsTextOutput> => {
          const r = await ink.llms(input.url, { mode, fresh: input.fresh, signal: abortSignal });
          return { url: r.url, title: r.title, kind: r.kind, source: r.source, tokens: r.tokens, pages: r.pages, cached: r.cached, ...cut(r.text, max, hint) };
        }),
    });

  const all: LlmsInkTools = {
    llmsTxt: llmsTool(
      'llms',
      'Get an llms.txt index for any link (site, docs section, page, GitHub repo, PDF or video): title, one-line summary, and sections of the most useful links with short descriptions. ' +
        'Returns the site’s own llms.txt when it has one. Cached 24h.',
      'Open only the linked pages you need.',
    ),
    llmsFullTxt: llmsTool(
      'full',
      'Get llms-full.txt for any link: the llms.txt index followed by the full Markdown of up to 20 pages it links to ' +
        '(or the page/document itself; for a video, its description and timestamped transcript). Can be large — prefer llmsTxt when you only need to find pages. Cached 24h.',
      'Call llmsTxt for the index, then llmsFullTxt on the one page or section you need.',
    ),
    checkLlmsTxt: tool({
      description:
        'Check an llms.txt against the format (H1 title, blockquote summary, H2 sections of `- [name](url): notes` links) and size. ' +
        'Pass `url` to check the file a site publishes, including whether its first 25 links answer; or pass `text` to check a file you have (a draft, a local copy), ' +
        'with `base` for where it lives and `links` to also test its links. Returns a short report with each issue and its line, and the sections with their link counts.',
      inputSchema: z.object({
        url: z.string().optional().describe('A site, a docs section, or the llms.txt itself, e.g. "llmstxt.org" or "docs.astro.build/llms.txt". Use url or text.'),
        text: z.string().optional().describe('The llms.txt itself (up to 2 MB), instead of url.'),
        base: z.string().optional().describe('With text: the site or llms.txt link it belongs to, e.g. "example.com". Resolves relative links.'),
        links: z.boolean().optional().describe('With text: also check that its first 25 links answer (and llms-full.txt next to base). Default false.'),
      }),
      execute: (input: CheckInput, { abortSignal }) =>
        attempt(async (): Promise<CheckOutput | LlmsInkToolError> => {
          if ((input.text === undefined) === !input.url) {
            return { error: 'Pass url (a published llms.txt) or text (the file itself), not both.', code: 'invalid_request' };
          }
          const r =
            input.text === undefined
              ? await ink.check(input.url!, { signal: abortSignal })
              : await ink.checkText(input.text, { base: input.base, links: input.links, signal: abortSignal });
          return { url: r.url, site: r.site, found: r.found, summary: r.summary, ...cut(checkReport(r), max, 'Fix the issues shown, then check again.') };
        }),
    }),
    agentView: tool({
      description:
        'Report how AI crawlers and agents see a page: robots.txt per AI bot (search, user fetches, training) and Content-Signal, firewall blocks found by fetching with bot User-Agents, text present without JavaScript, what survives Markdown conversion, ' +
        'title/first paragraph/facts/noindex/canonical/sitemap, hidden instructions, and llms.txt, .md URLs, Accept: text/markdown, Link headers, ard.json. Each check is pass/warn/fail/info with a fix. ' +
        'Use it to tell a site owner why assistants can’t read or cite a page and what to change.',
      inputSchema: z.object({
        url: z.string().describe('A site or any page on it, e.g. "example.com" or "docs.example.com/guide". The scheme is optional.'),
      }),
      execute: (input: AgentViewInput, { abortSignal }) =>
        attempt(async (): Promise<AgentViewOutput> => {
          const r = await ink.report(input.url, { signal: abortSignal });
          return { url: r.url, site: r.site, summary: r.summary, ...cut(reportText(r), max, 'Fix the failures shown first.') };
        }),
    }),
  };

  const picked: Partial<LlmsInkTools> = {};
  for (const name of include) Object.assign(picked, { [name]: all[name] });
  return picked as Pick<LlmsInkTools, K>;
}

/** `text` cut to `max` characters (at a line break when one is near), with a note saying what was left out. */
function cut(text: string, max: number, hint: string): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--; // don't split a surrogate pair
  const newline = text.lastIndexOf('\n', end);
  if (newline > end * 0.9) end = newline;
  return {
    text: `${text.slice(0, end)}\n\n[Truncated: showing ${end} of ${text.length} characters. ${hint}]`,
    truncated: true,
  };
}

/** Runs a tool body; llms.ink errors become a {@link LlmsInkToolError}, an invalid key and anything else throw. */
async function attempt<T>(run: () => Promise<T>): Promise<T | LlmsInkToolError> {
  try {
    return await run();
  } catch (err) {
    if (!(err instanceof LlmsInkError) || err instanceof InvalidKeyError) throw err;
    const wait = err.retryAfter;
    const out: LlmsInkToolError = { error: errorText(err, wait) };
    if (err.code) out.code = err.code;
    if (wait !== undefined) out.retryAfter = wait;
    return out;
  }
}

function errorText(err: LlmsInkError, wait: number | undefined): string {
  if (err instanceof RateLimitedError) return `llms.ink rate limit: wait ${wait ?? 60} seconds, then try again.`;
  if (err instanceof QuotaExceededError) {
    return `llms.ink daily quota of new links is used up${wait === undefined ? '' : `; it resets in ${wait} seconds (midnight UTC)`}. Cached links still work.`;
  }
  return `llms.ink: ${err.detail}`;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** The check as a short report (the same as the MCP tool's). */
function checkReport(r: CheckResult): string {
  const lines = r.issues.map((i) => `- ${i.level}${i.line ? ` (line ${i.line})` : ''}: ${i.message}`);
  if (!r.found) return [`No llms.txt found for ${r.site ?? 'this text'}.`, '', ...lines].join('\n');
  const facts = [
    `${plural(r.summary.errors, 'error')}, ${plural(r.summary.warnings, 'warning')}`,
    plural(r.sections, 'section'),
    `${plural(r.links.total, 'link')} (${r.links.checked || !r.links.total ? `${r.links.checked} checked, ${r.links.broken.length} broken` : 'not checked'})`,
    `~${r.tokens} tokens`,
    ...(r.llmsFull === null ? [] : [`llms-full.txt ${r.llmsFull ? 'found' : 'not found'}`]),
  ];
  const outline = r.parsed?.sections.length
    ? ['', `Sections: ${r.parsed.sections.map((s) => `${s.name} (${plural(s.links.length, 'link')})`).join(', ')}`]
    : [];
  const broken = r.links.broken.map((b) => `- broken link (${b.status || 'no answer'}): ${b.url}`);
  return [`${r.url ?? 'llms.txt'}: ${facts.join(' · ')}`, ...outline, '', ...lines, ...broken].join('\n');
}

/** The agent's-eye report as text (the same as the MCP tool's). */
function reportText(r: ReportResult): string {
  const mark = { pass: '✓', warn: '!', fail: '✕', info: '·' } as const;
  const lines = [`${r.url}: ${r.summary.fail} fail, ${r.summary.warn} warn, ${r.summary.pass} pass, ${r.summary.info} info`];
  for (const s of r.sections) {
    lines.push('', `## ${s.title}`);
    for (const c of s.checks) {
      lines.push(`${mark[c.status]} ${c.status} · ${c.title}: ${c.detail}`);
      if (c.evidence && c.status !== 'pass') lines.push(...c.evidence.split('\n').slice(0, 8).map((l) => `    ${l}`));
      if (c.fix && c.status !== 'pass') lines.push(`  fix (${c.fix.kind}): ${c.fix.summary}${c.fix.patch ? ` [patch for ${c.fix.patch.file}]` : ''}`);
    }
  }
  return lines.join('\n');
}
