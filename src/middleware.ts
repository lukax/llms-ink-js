/**
 * Serve llms.txt, llms-full.txt and (optionally) Markdown versions of pages from llms.ink, inside your own app, and
 * (optionally) count AI-agent traffic. A fetch-API handler for Cloudflare Workers, Next.js middleware, Deno, Bun and
 * Hono, plus an Express/Connect adapter.
 *
 * @example
 * ```ts
 * import { llmsInkHandler } from 'llms-ink/middleware';
 *
 * const llms = llmsInkHandler({ site: 'https://example.com', markdown: true });
 * export default {
 *   async fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> {
 *     return (await llms(request, ctx)) ?? fetch(request); // undefined: not ours, the app answers
 *   },
 * };
 * ```
 *
 * @module
 */

import { env } from './env.ts';
import { DEFAULT_BASE_URL, VERSION, type Mode } from './index.ts';
import { trafficCounter, type TrafficOptions, type WaitUntil } from './traffic.ts';

export { AI_AGENTS, classifyAgent, trafficCounter, type AgentKind, type AiAgent, type TrafficBatch, type TrafficCounter, type TrafficOptions, type TrafficRow, type WaitUntil } from './traffic.ts';

/** Options for {@link llmsInkHandler} and {@link llmsInkExpress}. */
export interface LlmsInkHandlerOptions {
  /** The deployed site to describe, e.g. `https://example.com`. */
  site: string;
  /**
   * API key (`lk_…`), sent as `Authorization: Bearer`. Defaults to the `LLMS_INK_KEY` environment variable
   * where there is one. Recommended: proxies on shared hosting IPs otherwise share the anonymous limits.
   */
  key?: string;
  /**
   * Also answer `<path>.md`, and page requests whose `Accept` prefers `text/markdown` over `text/html`, with the
   * page as Markdown (`https://llms.ink/full/<page>`). Default `false`.
   */
  markdown?: boolean;
  /** Defaults to the `LLMS_INK_API` environment variable, else https://llms.ink. */
  baseUrl?: string;
  /**
   * Count requests from AI agents (ChatGPT-User, Claude-User, GPTBot, ClaudeBot… see `AI_AGENTS`) per path and send
   * daily aggregates to llms.ink every `flushEvery` seconds; read them at https://llms.ink/traffic/. Sends only
   * `{ path, agent, kind, count }`: no IPs, user agents, query strings or cookies. Off unless set.
   */
  traffic?: TrafficOptions;
}

/**
 * A fetch-API handler: a `Response` for the requests it serves, `undefined` for everything else. Pass the
 * platform's `ctx` (Workers' `ExecutionContext`, Next.js's `NextFetchEvent`) so traffic sends outlive the response.
 */
export interface LlmsInkHandler {
  (request: Request, ctx?: WaitUntil): Promise<Response | undefined>;
  /** Sends the traffic counted so far (with `traffic`); resolves at once without it. */
  flush(): Promise<void>;
}

const FILES: Record<string, Mode> = { '/llms.txt': 'llms', '/llms-full.txt': 'full' };
/** llms.ink's own fetcher (`compatible; llms.ink/0.1`): answering it from llms.ink would loop. */
const LLMS_INK_FETCHER = /\bllms\.ink\/\d/;
/** Response headers passed through from llms.ink. */
const PASS = ['content-type', 'cache-control', 'x-llms-kind', 'x-llms-source', 'x-llms-tokens'];
/** Pages kept in memory as last good copies; the oldest is dropped first. */
const MAX_ENTRIES = 200;
/** How long downstream caches may keep a stale copy served while llms.ink fails. */
const STALE_CACHE_CONTROL = 'public, max-age=60';

interface Entry {
  body: string;
  headers: Headers;
  /** `Date.now()` when fetched. */
  at: number;
  /** Seconds, from the upstream `Cache-Control: max-age`. */
  maxAge: number;
}

/**
 * Answers `GET`/`HEAD` `/llms.txt` and `/llms-full.txt` with llms.ink's generated files for `site`
 * (`native=0`, so a site whose /llms.txt is this handler can't loop), and, with `markdown: true`, Markdown
 * versions of pages. Responses keep llms.ink's `Cache-Control`; each one is kept in memory for its `max-age`
 * and served as a last good copy (with `Warning: 110`) when llms.ink fails. Returns `undefined` for every
 * other request, and for llms.ink's own fetcher.
 */
export function llmsInkHandler(options: LlmsInkHandlerOptions): LlmsInkHandler {
  const base = (options.baseUrl ?? env('LLMS_INK_API') ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const key = (options.key ?? env('LLMS_INK_KEY'))?.trim();
  const site = new URL(/^https?:\/\//i.test(options.site) ? options.site : `https://${options.site}`);
  const headers: Record<string, string> = { accept: 'text/plain', 'user-agent': `llms-ink-js/${VERSION}` };
  if (key) headers.authorization = `Bearer ${key}`;
  const cache = new Map<string, Entry>();
  const pending = new Map<string, Promise<Response>>();
  const traffic = options.traffic ? trafficCounter({ ...options.traffic, site: options.traffic.site ?? site.hostname, baseUrl: base }) : null;

  /** Fetches `upstream`; on failure the last good copy, else llms.ink's error. */
  async function refresh(upstream: string): Promise<Response> {
    const last = cache.get(upstream);
    let res: Response;
    try {
      res = await fetch(upstream, { headers });
    } catch (err) {
      return last ? stale(last) : failure(502, 'upstream_error', `Couldn't reach llms.ink: ${err instanceof Error ? err.message : err}`);
    }
    // An older llms.ink without `format=text` answers JSON; never serve that as the file.
    const isText = res.headers.get('content-type')?.startsWith('text/');
    if (!res.ok || !isText) {
      if (last) {
        await res.body?.cancel();
        return stale(last);
      }
      if (res.ok) return failure(502, 'upstream_error', `llms.ink answered ${res.headers.get('content-type')}, not text.`);
      return new Response(res.body, { status: res.status, headers: pick(res.headers, [...PASS, 'x-error-code', 'retry-after']) });
    }
    const maxAge = Number(/(?:^|,)\s*max-age=(\d+)/i.exec(res.headers.get('cache-control') ?? '')?.[1] ?? 0);
    const entry: Entry = { body: await res.text(), headers: pick(res.headers, PASS), at: Date.now(), maxAge };
    cache.delete(upstream);
    cache.set(upstream, entry);
    if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
    return fresh(entry);
  }

  async function serve(upstream: string): Promise<Response> {
    const hit = cache.get(upstream);
    if (hit && Date.now() - hit.at < hit.maxAge * 1000) return fresh(hit);
    let loading = pending.get(upstream);
    if (!loading) {
      loading = refresh(upstream).finally(() => pending.delete(upstream));
      pending.set(upstream, loading);
    }
    // Concurrent requests share one fetch; each gets its own copy of the body.
    return (await loading).clone();
  }

  const handler = async (request: Request, ctx?: WaitUntil): Promise<Response | undefined> => {
    traffic?.record(request, ctx);
    if (request.method !== 'GET' && request.method !== 'HEAD') return undefined;
    if (LLMS_INK_FETCHER.test(request.headers.get('user-agent') ?? '')) return undefined;
    const { pathname } = new URL(request.url);
    const mode = FILES[pathname];
    let response: Response;
    if (mode) {
      const query = new URLSearchParams({ url: site.href, mode, native: '0', format: 'text' });
      response = await serve(`${base}/api/v0/llms?${query}`);
    } else if (options.markdown && pathname.endsWith('.md')) {
      const page = pathname.slice(0, -3).replace(/\/index$/, '/');
      response = await serve(`${base}/full/${site.host}${page}`);
    } else if (options.markdown && isPage(pathname) && prefersMarkdown(request.headers.get('accept') ?? '')) {
      response = await serve(`${base}/full/${site.host}${pathname}`);
      response.headers.append('vary', 'Accept');
    } else {
      return undefined;
    }
    return request.method === 'HEAD' ? new Response(null, response) : response;
  };
  return Object.assign(handler, { flush: () => traffic?.flush() ?? Promise.resolve() });
}

/** Node's `IncomingMessage` (Express, Connect, plain `node:http`), as far as the adapter reads it. */
export interface NodeRequest {
  method?: string;
  url?: string;
  /** Express: the URL before mounting stripped a prefix. */
  originalUrl?: string;
  headers: Record<string, string | string[] | undefined>;
}

/** Node's `ServerResponse`, as far as the adapter writes it. */
export interface NodeResponse {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  end(chunk: Uint8Array): unknown;
}

/** Express/Connect middleware: `next()` when the request isn't one {@link llmsInkHandler} serves. */
export interface NodeMiddleware {
  (req: NodeRequest, res: NodeResponse, next: (err?: unknown) => void): void;
  /** Sends the traffic counted so far (with `traffic`). */
  flush(): Promise<void>;
}

/** {@link llmsInkHandler} as Express/Connect middleware: `app.use(llmsInkExpress({ site }))`. */
export function llmsInkExpress(options: LlmsInkHandlerOptions): NodeMiddleware {
  const handle = llmsInkHandler(options);
  const middleware = (req: NodeRequest, res: NodeResponse, next: (err?: unknown) => void): void => {
    const headers = new Headers();
    for (const name of ['accept', 'user-agent']) {
      const value = req.headers[name];
      if (typeof value === 'string') headers.set(name, value);
    }
    const request = new Request(new URL(req.originalUrl ?? req.url ?? '/', 'http://localhost'), { method: req.method, headers });
    handle(request)
      .then(async (response) => {
        if (!response) return next();
        res.statusCode = response.status;
        response.headers.forEach((value, name) => res.setHeader(name, value));
        res.end(new Uint8Array(await response.arrayBuffer()));
      })
      .catch(next);
  };
  return Object.assign(middleware, { flush: handle.flush });
}

function pick(from: Headers, names: string[]): Headers {
  const to = new Headers();
  for (const name of names) {
    const value = from.get(name);
    if (value !== null) to.set(name, value);
  }
  return to;
}

function fresh(entry: Entry): Response {
  const headers = new Headers(entry.headers);
  headers.set('age', String(Math.floor((Date.now() - entry.at) / 1000)));
  return new Response(entry.body, { headers });
}

function stale(entry: Entry): Response {
  const response = fresh(entry);
  response.headers.set('cache-control', STALE_CACHE_CONTROL);
  response.headers.set('warning', '110 - "Response is Stale"');
  return response;
}

function failure(status: number, code: string, detail: string): Response {
  return new Response(`${detail}\n`, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'x-error-code': code } });
}

/** A page path: no file extension, or `.html`/`.htm`. */
function isPage(pathname: string): boolean {
  const last = pathname.slice(pathname.lastIndexOf('/') + 1);
  return !last.includes('.') || /\.html?$/i.test(last);
}

/**
 * Whether `Accept` names `text/markdown` with a quality at least that of `text/html` (or, when `text/html`
 * isn't listed, `text/*`, then `*\/*`). Browsers never list `text/markdown`, so they get the app.
 */
function prefersMarkdown(accept: string): boolean {
  let markdown = 0;
  const html: Record<string, number> = {};
  for (const part of accept.toLowerCase().split(',')) {
    const [type = '', ...params] = part.split(';').map((s) => s.trim());
    const q = params.find((p) => p.startsWith('q='));
    const quality = q === undefined ? 1 : Number(q.slice(2));
    if (!Number.isFinite(quality)) continue;
    if (type === 'text/markdown' || type === 'text/x-markdown') markdown = Math.max(markdown, quality);
    else if (type === 'text/html' || type === 'text/*' || type === '*/*') html[type] = Math.max(html[type] ?? 0, quality);
  }
  return markdown > 0 && markdown >= (html['text/html'] ?? html['text/*'] ?? html['*/*'] ?? 0);
}
