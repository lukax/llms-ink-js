/**
 * Client for the llms.ink JSON API (https://llms.ink/docs/): any public link — site, docs section, page,
 * GitHub repo, PDF or video — as llms.txt or llms-full.txt. No dependencies; uses the global `fetch`, so it
 * runs on Node ≥ 18, Bun, Deno, Cloudflare Workers and browsers.
 *
 * @example
 * ```ts
 * import { LlmsInk } from "llms-ink";
 *
 * const ink = new LlmsInk();
 * const { title, text } = await ink.llms("developers.cloudflare.com/kv/", { mode: "full" });
 * ```
 *
 * @module
 */

import { prepareInspection, inspectionJson, inspectionReceipt, type InspectionReceipt } from './inspect.ts';
export type { InspectionReceipt } from './inspect.ts';

import { env } from './env.ts';

export const VERSION = '0.7.0';
export const DEFAULT_BASE_URL = 'https://llms.ink';

/* ── Response shapes (mirror src/lib/schemas.ts of the API) ──────────────── */

/** `llms` for the index (llms.txt), `full` for llms-full.txt. */
export type Mode = 'llms' | 'full';

/** What the link is. */
export type Kind = 'site' | 'section' | 'page' | 'repo' | 'document' | 'video' | 'channel';

/** `native` = published by the site; `generated` = made by llms.ink. */
export type Source = 'native' | 'generated';

/** A transcript line; `start` and `end` are seconds into the source video. */
export interface Segment {
  start: number;
  end: number;
  text: string;
}

/** Video results only: what `/api/v0/frame` and `/api/v0/media` can serve. */
export interface Media {
  /** Seconds. */
  duration: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
  thumbnail: string | null;
  downloads: Array<'mp4' | 'm4a'>;
  isLive?: boolean;
  transcript?: { source: string; segments: Segment[] };
}

/** `GET /api/v0/llms`: the llms.txt or llms-full.txt of a link and what it was built from. */
export interface Result {
  /** The link after normalization. */
  url: string;
  kind: Kind;
  source: Source;
  mode: Mode;
  title: string;
  /** The llms.txt or llms-full.txt content (Markdown). */
  text: string;
  /** Approximate token count (characters ÷ 4). */
  tokens: number;
  /** Links in llms.txt (mode `llms`) or pages inlined (mode `full`). */
  pages: number;
  /** Model that wrote the descriptions; null for native files or path-based grouping. */
  model: string | null;
  cached: boolean;
  /** ISO 8601 date-time. */
  generatedAt: string;
  media?: Media;
}

/** One finding of the checker. */
export interface CheckIssue {
  /** `error` breaks the format or a link; `warning` is worth fixing; `info` is a note. */
  level: 'error' | 'warning' | 'info';
  /** Stable name of the check, e.g. `missing_title`, `broken_link`. */
  code: string;
  /** Line in the file, when the issue has one. */
  line: number | null;
  message: string;
}

/** One link of a section: `- [title](url): notes`. */
export interface ParsedLink {
  title: string;
  /** Resolved against `base` / the fetched URL when possible, else as written. */
  url: string;
  /** Text after `:`, trimmed. */
  notes: string | null;
  line: number;
}

/** An H2 section of llms.txt. */
export interface ParsedSection {
  name: string;
  /** The section is named "Optional" (case-insensitive). */
  optional: boolean;
  /** Non-link content of the section. */
  text: string | null;
  links: ParsedLink[];
}

/** The structure of an llms.txt file. */
export interface ParsedLlms {
  /** The H1. */
  title: string | null;
  /** The blockquote, without `> `. */
  summary: string | null;
  /** Markdown between the summary and the first H2. */
  details: string | null;
  sections: ParsedSection[];
}

/** `GET` / `POST /api/v0/check`: an llms.txt checked against the format and its links. */
export interface CheckResult {
  /** The site's origin; null for {@link LlmsInk.checkText} without `base`. */
  site: string | null;
  /** The llms.txt that was checked (or the last place looked when none was found); null for text without `base`. */
  url: string | null;
  found: boolean;
  /** HTTP status of the llms.txt request. */
  status: number;
  title: string | null;
  tokens: number;
  /** H2 sections. */
  sections: number;
  links: {
    total: number;
    /** Links fetched this run (the first 25); 0 when links weren't checked. */
    checked: number;
    /** `status` is 0 when the link didn't answer in time. */
    broken: Array<{ url: string; status: number }>;
  };
  /** Whether llms-full.txt is published next to it; null when not checked. */
  llmsFull: boolean | null;
  /** The parsed file; null when nothing was found. */
  parsed: ParsedLlms | null;
  /** Errors first, then warnings and notes, in line order. */
  issues: CheckIssue[];
  summary: { errors: number; warnings: number };
  /** ISO 8601 date-time. */
  checkedAt: string;
}

/** `pass` is fine; `warn` is worth fixing; `fail` keeps agents out or empties the page for them; `info` is a fact. */
export type ReportStatus = 'pass' | 'warn' | 'fail' | 'info';

/** How to fix a check that didn't pass. */
export interface ReportFix {
  /** Where the change goes. */
  kind: 'robots' | 'markdown' | 'llms-txt' | 'indexnow' | 'content' | 'html' | 'headers' | 'other';
  /** What to change, in a sentence. */
  summary: string;
  /** A concrete change, when one is possible: `file` from the site root and its new content or lines to add. */
  patch?: { file: string; content: string };
}

/** One check of the agent's-eye report. */
export interface ReportCheck {
  /** Stable name of the check, e.g. `bots-search`, `raw-text`. */
  id: string;
  status: ReportStatus;
  title: string;
  /** What was found, for people. */
  detail: string;
  /** What it's based on: lines, headers, snippets, sizes. */
  evidence?: string;
  fix?: ReportFix;
}

/** `GET /api/v0/report`: how AI crawlers and agents see a page, each problem with its fix. */
export interface ReportResult {
  /** The page reported on, after normalization and redirects. */
  url: string;
  /** Its origin. */
  site: string;
  /** ISO 8601 date-time. */
  checkedAt: string;
  summary: { pass: number; warn: number; fail: number; info: number };
  /** In order: access, rendering, extraction, retrieval, hidden instructions, agent files. */
  sections: Array<{ id: string; title: string; checks: ReportCheck[] }>;
}

/** Every error code the API answers with (https://llms.ink/docs/#errors). */
export type ErrorCode =
  | 'inspection_not_enabled'
  | 'inspection_quota'
  | 'inspection_unavailable'
  | 'invalid_request'
  | 'invalid_url'
  | 'invalid_key'
  | 'key_required'
  | 'site_claimed'
  | 'not_found'
  | 'unknown_version'
  | 'method_not_allowed'
  | 'payload_too_large'
  | 'too_large'
  | 'unsupported_media_type'
  | 'unprocessable'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'internal'
  | 'upstream_error'
  | 'unavailable'
  | 'timeout'
  | 'loop_detected';

/** `invalid_request` only: one invalid parameter. */
export interface Issue {
  path: string;
  message: string;
}

/** An error body (RFC 9457 problem details), sent as `application/problem+json`. */
export interface Problem {
  type: string;
  title: string;
  status: number;
  code: ErrorCode;
  detail: string;
  errors?: Issue[];
}

/** Build stages reported while streaming. */
export type Stage = 'cache' | 'index' | 'extract' | 'ready';

/**
 * One line of the `application/x-ndjson` stream of `GET /api/v0/llms`. `partial` text is explicitly
 * incomplete; `result` is the last event. A terminal `error` event is thrown as an {@link LlmsInkError}.
 */
export type StreamEvent =
  | { type: 'progress'; stage: Stage; detail: string }
  | { type: 'partial'; text: string }
  | { type: 'result'; result: Result };

/* ── Errors ──────────────────────────────────────────────────────────────── */

/** Fields of an {@link LlmsInkError} besides the message. */
export interface LlmsInkErrorInit {
  status?: number;
  code?: string;
  title?: string;
  errors?: Issue[];
  retryAfter?: number;
  cause?: unknown;
}

/**
 * An API error, or llms.ink couldn't be reached (then `status` and `code` are undefined).
 * `code` is the problem's machine-readable code (`invalid_url`, `unprocessable`, `upstream_error`…),
 * `detail` the human-readable message, `errors` the per-parameter issues of `invalid_request`.
 * `retryAfter` is the `Retry-After` header in seconds, when the response had one.
 */
export class LlmsInkError extends Error {
  readonly detail: string;
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly title: string | undefined;
  readonly errors: Issue[];
  readonly retryAfter: number | undefined;

  constructor(detail: string, init: LlmsInkErrorInit = {}) {
    super(detail, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = new.target.name;
    this.detail = detail;
    this.status = init.status;
    this.code = init.code;
    this.title = init.title;
    this.errors = init.errors ?? [];
    this.retryAfter = init.retryAfter;
  }
}

/** 401 `invalid_key`: the API key is malformed, unknown or revoked. Requests never fall back to anonymous. */
export class InvalidKeyError extends LlmsInkError {}

/** 429 `rate_limited`: too many requests this minute; wait `retryAfter` seconds. */
export class RateLimitedError extends LlmsInkError {}

/**
 * 429 `quota_exceeded`: the daily quota of new links is used up; `retryAfter` is the seconds until it resets
 * (midnight UTC). Cached links still work.
 */
export class QuotaExceededError extends LlmsInkError {}

const BY_CODE: Record<string, typeof LlmsInkError> = {
  invalid_key: InvalidKeyError,
  rate_limited: RateLimitedError,
  quota_exceeded: QuotaExceededError,
};

const errorFor = (detail: string, init: LlmsInkErrorInit): LlmsInkError =>
  new (BY_CODE[init.code ?? ''] ?? LlmsInkError)(detail, init);

/* ── Client ──────────────────────────────────────────────────────────────── */

/** Options for {@link LlmsInk}. */
export interface LlmsInkOptions {
  /**
   * API key (`lk_…`), sent as `Authorization: Bearer`. Defaults to the `LLMS_INK_KEY` environment variable
   * where there is one; without a key, requests are anonymous and share the free limits.
   */
  key?: string;
  /** Defaults to the `LLMS_INK_API` environment variable, else https://llms.ink. */
  baseUrl?: string;
  /** A `fetch` to use instead of the global one. */
  fetch?: typeof fetch;
}

/** Options for {@link LlmsInk.llms} and {@link LlmsInk.stream}. */
export interface LlmsOptions {
  /** `llms` (default) for the index, `full` for llms-full.txt (the content inlined, up to 20 pages). */
  mode?: Mode;
  /** Skip the cache and rebuild (counts against the daily quota). */
  fresh?: boolean;
  /**
   * `false` always generates the file from the site's pages and never returns the site's own llms.txt or
   * llms-full.txt (`native=0`). Defaults to `true`: a site's own file is returned as is, unless it carries the
   * llms.ink credit line (then it's regenerated).
   */
  native?: boolean;
  /** Aborts the request; the abort error is rethrown as is. */
  signal?: AbortSignal;
}

/** Options for {@link LlmsInk.check}. */
export interface CheckOptions {
  signal?: AbortSignal;
}

/** Options for {@link LlmsInk.report}. */
export interface ReportOptions {
  signal?: AbortSignal;
}

/** Options for {@link LlmsInk.checkText}. */
export interface CheckTextOptions {
  /** Public URL the text lives at: resolves relative links and is reported as `url` / `site`. */
  base?: string;
  /** Also check up to 25 linked URLs (and llms-full.txt next to `base`). Defaults to `false`. */
  links?: boolean;
  signal?: AbortSignal;
}

/** Options for {@link LlmsInk.markdown}. */
export interface MarkdownOptions {
  /** Where the page lives (never fetched): relative links in the Markdown resolve against it. */
  url?: string;
  signal?: AbortSignal;
}

/** Browsers refuse or preflight a custom User-Agent, so it's only sent from servers. */
const IS_BROWSER: boolean = 'document' in globalThis || 'WorkerGlobalScope' in globalThis;

/** `Retry-After` as seconds: delta-seconds, or an HTTP date turned into seconds from now. */
function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v);
  const when = Date.parse(v);
  return Number.isNaN(when) ? undefined : Math.max(0, Math.ceil((when - Date.now()) / 1000));
}

/** Aborts (`signal`, `AbortSignal.timeout`) are the caller's doing and pass through unwrapped. */
const isAbort = (err: unknown): boolean => err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');

/**
 * A client for https://llms.ink.
 *
 * Building a big site or a video can take minutes; pass a `signal` (e.g. `AbortSignal.timeout(300_000)`) to
 * bound a call, or use {@link LlmsInk.stream} to watch progress.
 */
export class LlmsInk {
  /** The API key in use, if any. */
  readonly key: string | undefined;
  /** Origin of the API, without a trailing slash. */
  readonly baseUrl: string;
  readonly #inspectBaseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: LlmsInkOptions = {}) {
    const key = (options.key ?? env('LLMS_INK_KEY'))?.trim();
    this.key = key || undefined;
    this.#inspectBaseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.baseUrl = (options.baseUrl ?? env('LLMS_INK_API') ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    if (!options.fetch && typeof globalThis.fetch !== 'function') {
      throw new TypeError('No global fetch: use Node 18+ or pass options.fetch.');
    }
    // Wrapped so the global is called unbound-safe (browsers throw "Illegal invocation" otherwise).
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  /**
   * llms.txt (`mode: 'llms'`, an index of links) or llms-full.txt (`mode: 'full'`, the content inlined) for
   * any public link.
   */
  async llms(url: string, options: LlmsOptions = {}): Promise<Result> {
    const res = await this.#request('/api/v0/llms', llmsParams(url, options), 'application/json', options.signal);
    return (await this.#json(res)) as Result;
  }

  /**
   * Explicitly upload supplied text to the hosted Inspect pilot. Requires an enabled key.
   * The receipt binds to these exact UTF-8 bytes; no finding is not a safety guarantee.
   * No retries. 65-second default deadline. LLMS_INK_API is ignored; baseUrl must be explicit.
   * Keep keys server-side. Malformed receipts and HTTP problems throw LlmsInkError.
   */
  async inspect(text: string, options: { signal?: AbortSignal } = {}): Promise<InspectionReceipt> {
    if (!this.key) throw new LlmsInkError('Inspect requires an inspection-enabled API key.', {code:'key_required'});
    const {body, digest} = await prepareInspection(text, this.#inspectBaseUrl);
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    const timer = setTimeout(() => controller.abort(new DOMException('Inspection timed out.', 'TimeoutError')), 65000);
    if(options.signal?.aborted) abort();
    options.signal?.addEventListener('abort', abort, {once:true});
    try {
      const res = await this.#fetch(`${this.#inspectBaseUrl}/api/v0/inspect`, {
        method:'POST', redirect:'error', signal:controller.signal,
        headers:{authorization:`Bearer ${this.key}`, 'content-type':'application/json', accept:'application/json'}, body,
      });
      const data = await inspectionJson(res);
      if (!res.ok && data && typeof data === 'object' && !('detection' in data)) {
        const p = data as Partial<Problem>;
        throw errorFor(p.detail || p.title || `Inspect returned HTTP ${res.status}.`, {status:res.status, code:p.code, retryAfter:retryAfter(res.headers.get('retry-after'))});
      }
      return inspectionReceipt(data, digest, res.status);
    } catch (err) {
      if (err instanceof LlmsInkError || isAbort(err)) throw err;
      throw new LlmsInkError('Inspection did not return a valid receipt. Withhold the content.', {code:'inspection_unavailable'});
    } finally {
      clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
    }
  }

  /** Checks a site's published llms.txt against the llmstxt.org format and that its links answer. */
  async check(url: string, options: CheckOptions = {}): Promise<CheckResult> {
    const res = await this.#request('/api/v0/check', { url }, 'application/json', options.signal);
    return (await this.#json(res)) as CheckResult;
  }

  /**
   * How AI crawlers and agents see a page (`GET /api/v0/report`): robots.txt per AI bot, firewall blocks, text
   * without JavaScript, Markdown conversion, hidden instructions and agent files, each problem with its fix.
   */
  async report(url: string, options: ReportOptions = {}): Promise<ReportResult> {
    const res = await this.#request('/api/v0/report', { url }, 'application/json', options.signal);
    return (await this.#json(res)) as ReportResult;
  }

  /** Parses and checks llms.txt text you already have (`POST /api/v0/check`); nothing is published. */
  async checkText(text: string, options: CheckTextOptions = {}): Promise<CheckResult> {
    const params: Record<string, string> = {};
    if (options.base) params.base = options.base;
    if (options.links) params.links = '1';
    const res = await this.#request('/api/v0/check', params, 'application/json', options.signal, text);
    return (await this.#json(res)) as CheckResult;
  }

  /**
   * A page's HTML as Markdown (`POST /api/v0/markdown`, up to 5 MB): hidden-instruction text, scripts, navigation,
   * headers and footers dropped, the way llms.ink reads pages. Nothing is fetched or stored.
   */
  async markdown(html: string, options: MarkdownOptions = {}): Promise<string> {
    const params: Record<string, string> = options.url ? { url: options.url } : {};
    const res = await this.#request('/api/v0/markdown', params, 'text/markdown', options.signal, html, 'text/html; charset=utf-8');
    return res.text();
  }

  /**
   * Like {@link LlmsInk.llms}, as the build happens: yields `progress` and `partial` events, then one
   * `result`. Errors — including a terminal `error` event — are thrown as {@link LlmsInkError}s.
   * Breaking out of the loop cancels the request.
   */
  async *stream(url: string, options: LlmsOptions = {}): AsyncGenerator<StreamEvent, void, undefined> {
    const res = await this.#request('/api/v0/llms', llmsParams(url, options), 'application/x-ndjson', options.signal);
    if (!res.headers.get('content-type')?.includes('ndjson')) {
      yield { type: 'result', result: (await this.#json(res)) as Result };
      return;
    }
    if (!res.body) throw new LlmsInkError(`${this.baseUrl} sent an empty stream.`, { status: res.status });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let done = false;
    try {
      while (!done) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (err) {
          if (isAbort(err)) throw err;
          throw new LlmsInkError(`The stream from ${this.baseUrl} broke off: ${err instanceof Error ? err.message : err}`, { cause: err });
        }
        done = chunk.done;
        buffer += done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
        const lines = buffer.split('\n');
        buffer = done ? '' : lines.pop()!;
        for (const line of lines) {
          const event = line.trim() ? this.#event(line) : undefined;
          if (!event) continue;
          yield event;
          if (event.type === 'result') return;
        }
      }
    } finally {
      reader.cancel().catch(() => {});
    }
    throw new LlmsInkError(`The stream from ${this.baseUrl} ended without a result.`);
  }

  /** A stream line → its event; unknown event types (added later) are skipped, `error` is thrown. */
  #event(line: string): StreamEvent | undefined {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch (err) {
      throw new LlmsInkError(`${this.baseUrl} sent a stream line that isn't JSON.`, { cause: err });
    }
    if (!event || typeof event !== 'object' || !('type' in event)) return undefined;
    if (event.type === 'error') {
      const { detail, code, status } = event as Partial<Problem>;
      throw errorFor(detail || 'The build failed.', { status, code });
    }
    // The server's own event shapes, by type.
    const known = event.type === 'progress' || event.type === 'partial' || event.type === 'result';
    return known ? (event as StreamEvent) : undefined;
  }

  async #request(path: string, params: Record<string, string>, accept: string, signal: AbortSignal | undefined, body?: string, type = 'text/markdown; charset=utf-8'): Promise<Response> {
    const headers: Record<string, string> = { accept };
    if (body !== undefined) headers['content-type'] = type;
    if (!IS_BROWSER) headers['user-agent'] = `llms-ink-js/${VERSION}`;
    if (this.key) headers.authorization = `Bearer ${this.key}`;
    const query = new URLSearchParams(params).toString();
    const target = `${this.baseUrl}${path}${query ? `?${query}` : ''}`;
    let res: Response;
    try {
      res = await this.#fetch(target, body === undefined ? { headers, signal } : { method: 'POST', headers, body, signal });
    } catch (err) {
      if (isAbort(err)) throw err;
      throw new LlmsInkError(`Couldn't reach ${this.baseUrl}: ${err instanceof Error ? err.message : err}`, { cause: err });
    }
    if (!res.ok) throw await problem(res);
    return res;
  }

  async #json(res: Response): Promise<unknown> {
    const body = await res.text();
    try {
      return JSON.parse(body);
    } catch (err) {
      throw new LlmsInkError(`${this.baseUrl} answered with something other than JSON.`, { status: res.status, cause: err });
    }
  }
}

function llmsParams(url: string, { mode = 'llms', fresh, native = true }: LlmsOptions): Record<string, string> {
  if (mode !== 'llms' && mode !== 'full') {
    throw new TypeError(`mode must be 'llms' (the index) or 'full' (llms-full.txt), not ${JSON.stringify(mode)}`);
  }
  const params: Record<string, string> = { url, mode };
  if (fresh) params.fresh = '1';
  if (!native) params.native = '0';
  return params;
}

/** An HTTP error response → the typed error for its problem `code`. */
async function problem(res: Response): Promise<LlmsInkError> {
  let data: Partial<Problem> = {};
  try {
    const parsed: unknown = JSON.parse(await res.text());
    if (parsed && typeof parsed === 'object') data = parsed as Partial<Problem>;
  } catch {
    // not problem+json: fall back to the status line
  }
  const status = typeof data.status === 'number' ? data.status : res.status;
  const detail = data.detail || data.title || `HTTP ${res.status} ${res.statusText || 'error'}`.trim();
  return errorFor(detail, {
    status,
    code: data.code,
    title: data.title,
    errors: data.errors,
    retryAfter: retryAfter(res.headers.get('retry-after')),
  });
}
