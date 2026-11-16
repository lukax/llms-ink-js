/**
 * AI traffic: which AI agents fetch which pages of your site, and what they got back, counted in memory and sent to
 * llms.ink as daily aggregates (`POST /api/v0/traffic`). Only requests from the agents in {@link AI_AGENTS} are
 * counted; what leaves your server is `{ site, period, rows: [{ path, agent, kind, count, outcomes? }] }` — no IPs,
 * no user agents, no query strings, no cookies, no status codes or bodies, nothing about people who visit.
 *
 * @module
 */

import { DEFAULT_BASE_URL, VERSION } from './index.ts';
import { verifySignedAgent } from './signatures.ts';

/** `user`: fetched because someone asked an assistant; `crawler`: indexing for search or collecting for training. */
export type AgentKind = 'user' | 'crawler';

/** One AI agent: the name it puts in its User-Agent (matched case-insensitively), what kind it is, who runs it. */
export interface AiAgent {
  agent: string;
  kind: AgentKind;
  operator: string;
}

/**
 * The agents counted, from the operators' published bot lists. Robots-only tokens (`Google-Extended`,
 * `Applebot-Extended`) never appear in a User-Agent, so they aren't here: Googlebot and Applebot do that crawling.
 */
export const AI_AGENTS: readonly AiAgent[] = [
  // Fetches on behalf of someone asking an assistant right now.
  { agent: 'ChatGPT-User', kind: 'user', operator: 'OpenAI' },
  { agent: 'Claude-User', kind: 'user', operator: 'Anthropic' },
  { agent: 'Perplexity-User', kind: 'user', operator: 'Perplexity' },
  { agent: 'MistralAI-User', kind: 'user', operator: 'Mistral' },
  { agent: 'DuckAssistBot', kind: 'user', operator: 'DuckDuckGo' },
  { agent: 'meta-externalfetcher', kind: 'user', operator: 'Meta' },
  { agent: 'Google-NotebookLM', kind: 'user', operator: 'Google' },
  { agent: 'Amzn-User', kind: 'user', operator: 'Amazon' },
  // Crawlers: AI search indexes, training collection, and the search engines AI answers draw on.
  { agent: 'OAI-SearchBot', kind: 'crawler', operator: 'OpenAI' },
  { agent: 'GPTBot', kind: 'crawler', operator: 'OpenAI' },
  { agent: 'Claude-SearchBot', kind: 'crawler', operator: 'Anthropic' },
  { agent: 'ClaudeBot', kind: 'crawler', operator: 'Anthropic' },
  { agent: 'anthropic-ai', kind: 'crawler', operator: 'Anthropic' },
  { agent: 'PerplexityBot', kind: 'crawler', operator: 'Perplexity' },
  { agent: 'Google-CloudVertexBot', kind: 'crawler', operator: 'Google' },
  { agent: 'Googlebot', kind: 'crawler', operator: 'Google' },
  { agent: 'bingbot', kind: 'crawler', operator: 'Microsoft' },
  { agent: 'Applebot', kind: 'crawler', operator: 'Apple' },
  { agent: 'Amzn-SearchBot', kind: 'crawler', operator: 'Amazon' },
  { agent: 'Amazonbot', kind: 'crawler', operator: 'Amazon' },
  { agent: 'meta-externalagent', kind: 'crawler', operator: 'Meta' },
  { agent: 'Bytespider', kind: 'crawler', operator: 'ByteDance' },
  { agent: 'CCBot', kind: 'crawler', operator: 'Common Crawl' },
  { agent: 'cohere-ai', kind: 'crawler', operator: 'Cohere' },
  { agent: 'YouBot', kind: 'crawler', operator: 'You.com' },
  { agent: 'DuckDuckBot', kind: 'crawler', operator: 'DuckDuckGo' },
];

const BY_TOKEN = new Map(AI_AGENTS.map((a) => [a.agent.toLowerCase(), a]));
/** One pass over the User-Agent: a known name not glued to a preceding letter, digit or hyphen. */
const MATCH = new RegExp(`(?:^|[^a-z0-9-])(${AI_AGENTS.map((a) => a.agent.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')).join('|')})`, 'i');

/** The AI agent behind a User-Agent header, or null for browsers, other bots and anything unknown. */
export function classifyAgent(userAgent: string | null | undefined): AiAgent | null {
  if (!userAgent) return null;
  const match = MATCH.exec(userAgent);
  return match ? BY_TOKEN.get(match[1]!.toLowerCase()) ?? null : null;
}

/**
 * What a response gave the agent, from its status and `Content-Type` only. `markdown_missing`: a 2xx that isn't
 * Markdown (or plain text) for a `.md` URL or an `Accept` that prefers `text/markdown`.
 */
export type TrafficOutcome = 'ok' | 'redirect' | 'not_found' | 'blocked' | 'rate_limited' | 'client_error' | 'server_error' | 'markdown_missing';

/** Every {@link TrafficOutcome}, in the API's order. */
export const TRAFFIC_OUTCOMES: readonly TrafficOutcome[] = ['ok', 'redirect', 'not_found', 'blocked', 'rate_limited', 'client_error', 'server_error', 'markdown_missing'];

/** The parts of a response {@link classifyOutcome} reads: never the body. */
export interface ResponseLike {
  status: number;
  headers: { get(name: string): string | null };
}

const MARKDOWN_TYPES = /^(text\/markdown|text\/x-markdown|text\/plain)\s*(;|$)/i;

/**
 * The outcome of `request` answered with `response`, or null for a status that isn't a final HTTP response.
 * A 2xx without a `Content-Type` counts as `ok`: no evidence of a mismatch.
 */
export function classifyOutcome(request: Request, response: ResponseLike): TrafficOutcome | null {
  const status = response.status;
  if (!Number.isInteger(status) || status < 200 || status > 599) return null;
  if (status === 304) return 'ok';
  if (status >= 500) return 'server_error';
  if (status === 429) return 'rate_limited';
  if (status === 404 || status === 410) return 'not_found';
  if (status === 401 || status === 403 || status === 451) return 'blocked';
  if (status >= 400) return 'client_error';
  if (status >= 300) return 'redirect';
  const type = response.headers.get('content-type');
  if (!type || MARKDOWN_TYPES.test(type.trim())) return 'ok';
  // Asked for Markdown: a `.md` URL, or an `Accept` that prefers it.
  const wanted = /\.md$/i.test(new URL(request.url).pathname) || prefersMarkdown(request.headers.get('accept') ?? '');
  return wanted ? 'markdown_missing' : 'ok';
}

/**
 * Whether `Accept` names `text/markdown` with a quality at least that of `text/html` (or, when `text/html`
 * isn't listed, `text/*`, then `*\/*`). Browsers never list `text/markdown`.
 */
export function prefersMarkdown(accept: string): boolean {
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

/** Options for {@link trafficCounter}, and the middleware's `traffic` option. */
export interface TrafficOptions {
  /** API key (`lk_…`). Verify the hostname at llms.ink/traffic first; account keys share verified sites. */
  key: string;
  /** Hostname the counts are filed under, e.g. `example.com`. The middleware defaults it to its `site`. */
  site?: string;
  /** Seconds between sends. Default 60, from 10 to 86,400 (larger timer delays overflow and fire at once). */
  flushEvery?: number;
}

/** One aggregate: requests from one agent to one path in one UTC day, and the responses seen for them. */
export interface TrafficRow {
  path: string;
  agent: string;
  kind: AgentKind;
  /** Requests counted; 0 when the row carries only outcomes of requests counted in an earlier batch. */
  count: number;
  /** Of `count`, requests with a valid Web Bot Auth signature from the agent's operator (see `SIGNED_AGENTS`). */
  verified?: number;
  outcomes?: Partial<Record<TrafficOutcome, number>>;
}

/** The body of `POST /api/v0/traffic`. */
export interface TrafficBatch {
  site: string;
  /** UTC day, `YYYY-MM-DD`. */
  period: string;
  rows: TrafficRow[];
}

/** Workers' `ExecutionContext`, Next.js's `NextFetchEvent`: keeps a send alive after the response. */
export interface WaitUntil {
  waitUntil(promise: Promise<unknown>): void;
}

/** Counts AI-agent requests and sends them in the background. */
export interface TrafficCounter {
  /**
   * Counts the request when an AI agent sent it (`GET`/`HEAD` only). A request with a valid Web Bot Auth signature
   * from a known signer counts as that signer's agent, verified, whatever its User-Agent; signatures are checked in
   * the background (kept alive by `ctx`). When a send is due it starts one and hands it to `ctx.waitUntil`; without
   * `ctx`, a background timer sends. Never throws and never waits.
   */
  record(request: Request, ctx?: WaitUntil): void;
  /**
   * Adds what a request counted by {@link record} got back: pass the same `Request` object and the response you
   * send. Reads only the status and `Content-Type`. Once per request; uncounted requests and later calls are ignored.
   * Never throws.
   */
  observe(request: Request, response: ResponseLike, ctx?: WaitUntil): void;
  /** Sends everything counted so far. Never rejects; transient failures retry the unchanged batch for up to 24 hours. Counts remain in memory only. */
  flush(): Promise<void>;
}

/** Rows per POST (the API's limit). */
const ROWS_PER_POST = 1000;
/** Distinct path/agent/day rows kept in memory; past it, new paths count as `(other)`. */
const MAX_PENDING = 5000;
/** The path new rows are folded into once {@link MAX_PENDING} is reached. */
const OTHER_PATH = '/(other)';
const MAX_PATH = 512;
const MAX_BACKOFF_MS = 3_600_000;
const SEND_TIMEOUT_MS = 10_000;
const RETRY_LIFETIME_MS = 86_400_000;
type OutboundBatch = { body: string; id: string; expires: number };

/** The path only: no query string or fragment (URL.pathname has neither), capped in length. */
function cleanPath(url: string): string {
  const path = new URL(url).pathname || '/';
  return path.length > MAX_PATH ? path.slice(0, MAX_PATH) : path;
}

/**
 * A counter for one site. Use it directly in servers the middleware doesn't cover:
 * `counter.record(request, ctx)` for each request, `await counter.flush()` before shutting down.
 */
export function trafficCounter(options: TrafficOptions & { site: string; baseUrl?: string }): TrafficCounter {
  const key = options.key?.trim();
  if (!key) throw new TypeError('traffic needs an llms.ink API key (traffic: { key: "lk_…" }).');
  // `https://Example.com/x` or `example.com` → `example.com`.
  const site = new URL(/^https?:\/\//i.test(options.site) ? options.site : `https://${options.site}`).hostname.toLowerCase();
  const seconds = Number.isFinite(options.flushEvery) ? options.flushEvery! : 60;
  const every = Math.min(86_400, Math.max(10, seconds)) * 1000;
  const endpoint = `${(options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')}/api/v0/traffic`;
  const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'user-agent': `llms-ink-js/${VERSION}` };

  /** `period\tpath\tagent` → row. */
  const pending = new Map<string, TrafficRow & { period: string }>();
  interface Counted {
    period: string;
    path: string;
    /** Set once counted; a signed request waits for its signature check. */
    agent?: { agent: string; kind: AgentKind };
    /** A response observed before the signature check settled. */
    outcome?: TrafficOutcome;
    observed?: boolean;
  }
  /** Counted requests waiting for their response: the row they count in, so a late response can't move days. */
  const counted = new WeakMap<Request, Counted>();
  let queued: OutboundBatch[] = [];
  let lastSend = Date.now();
  let retryAt = 0;
  let backoff = 0;
  let inflight: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Set when llms.ink refuses the key or the site: counting stops, once, with a warning. */
  let stopped = false;

  /** Adds to a row (a new one past {@link MAX_PENDING} folds into {@link OTHER_PATH}); returns the path used. */
  function add(period: string, path: string, agent: string, kind: AgentKind, count: number, outcome?: TrafficOutcome, verified = 0): string {
    let id = `${period}\t${path}\t${agent}`;
    let row = pending.get(id);
    if (!row && pending.size >= MAX_PENDING) {
      path = OTHER_PATH;
      id = `${period}\t${path}\t${agent}`;
      row = pending.get(id);
    }
    if (!row) { row = { period, path, agent, kind, count: 0 }; pending.set(id, row); }
    row.count += count;
    if (verified) row.verified = (row.verified ?? 0) + verified;
    if (outcome) { row.outcomes ??= {}; row.outcomes[outcome] = (row.outcomes[outcome] ?? 0) + 1; }
    return path;
  }

  /** Starts a due send (kept alive by `ctx`), or arms the background timer. */
  function schedule(now: number, ctx?: WaitUntil) {
    const due = now - lastSend >= every || pending.size >= ROWS_PER_POST;
    if (!inflight && now >= retryAt && due) {
      const sending = flush();
      ctx?.waitUntil(sending);
    } else if (!ctx) {
      arm();
    }
  }

  function stop(message: string) {
    stopped = true;
    pending.clear();
    queued = [];
    clearTimeout(timer);
    console.warn(`llms-ink traffic: ${message} Counting stopped.`);
  }

  function retryLater(retryAfter: number | null) {
    backoff = Math.min(MAX_BACKOFF_MS, Math.max(every, backoff * 2));
    retryAt = Date.now() + Math.max(backoff, Math.min(86_400, retryAfter ?? 0) * 1000);
  }

  /** One POST; resolves to what to do with its rows. */
  async function send(batch: OutboundBatch): Promise<'sent' | 'drop' | 'stop' | { retryAfter: number | null }> {
    let res: Response;
    try {
      res = await fetch(endpoint, { method: 'POST', headers: { ...headers, 'idempotency-key': batch.id }, body: batch.body, signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
    } catch {
      return { retryAfter: null };
    }
    if (res.ok) {
      await res.body?.cancel();
      return 'sent';
    }
    // llms.ink's problem details (`code`, `detail`) say why a batch was refused.
    const problem: { code?: string; detail?: string } | null = await res.json().catch(() => null);
    const why = problem ? `${problem.code ?? ''}: ${problem.detail ?? ''}` : '';
    if (res.status === 429 || res.status >= 500) return { retryAfter: Number(res.headers.get('retry-after')) || null };
    if (res.status === 401 || res.status === 403) {
      stop(`llms.ink refused ${site} (${res.status} ${why || 'check the key'}).`);
      return 'stop';
    }
    console.warn(`llms-ink traffic: llms.ink rejected a batch for ${site} (${res.status} ${why}).`);
    return 'drop';
  }

  /** A queued body and identifier never change, including after a partial multi-batch send. */
  async function sendQueued(): Promise<boolean> {
    while (queued.length) {
      const batch = queued[0]!;
      if (Date.now() >= batch.expires) {
        console.warn(`llms-ink traffic: retry expired for ${site}; discarded an unconfirmed batch. Its earlier attempt may have succeeded.`);
        queued.shift(); continue;
      }
      const outcome = await send(batch);
      if (outcome === 'stop') return false;
      if (typeof outcome === 'object') { retryLater(outcome.retryAfter); return false; }
      queued.shift();
    }
    backoff = 0; retryAt = 0;
    return true;
  }

  async function drain(): Promise<void> {
    if (!(await sendQueued()) || stopped || !pending.size) return;
    const crypto = globalThis.crypto ?? (await import('node:crypto')).webcrypto;
    const expires = Date.now() + RETRY_LIFETIME_MS;
    const byPeriod = new Map<string, TrafficRow[]>();
    for (const { period, ...row } of pending.values()) {
      let rows = byPeriod.get(period); if (!rows) { rows = []; byPeriod.set(period, rows); }
      rows.push(row);
    }
    const batches: OutboundBatch[] = [];
    for (const [period, rows] of byPeriod) for (let i = 0; i < rows.length; i += ROWS_PER_POST) {
      const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map(x => x.toString(16).padStart(2, '0')).join('');
      batches.push({ body: JSON.stringify({ site, period, rows: rows.slice(i, i + ROWS_PER_POST) }), id: `ink-traffic-v1.${expires}.${nonce}`, expires });
    }
    pending.clear(); queued = batches;
    await sendQueued();
  }

  /** Pending new counts stay separate while the previous snapshot is waiting to retry. */
  async function flush(): Promise<void> {
    while (inflight) await inflight;
    if ((!pending.size && !queued.length) || stopped) return;
    clearTimeout(timer); timer = undefined; lastSend = Date.now();
    inflight = drain()
      .catch(() => { retryLater(null); })
      .finally(() => {
        inflight = null;
        if ((pending.size || queued.length) && !stopped) arm();
      });
    await inflight;
  }

  /** A background send where nothing keeps one alive (Node, Bun, Deno); unref'd so it never holds the process open. */
  function arm() {
    if (timer) return;
    // A day at most: a huge Retry-After would overflow the timer and fire at once.
    const delay = Math.min(86_400_000, Math.max(1000, Math.max(lastSend + every, retryAt) - Date.now()));
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, delay);
    // Node's and Bun's timers have unref(); elsewhere setTimeout returns a number.
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
  }

  return {
    record(request, ctx) {
      try {
        if (stopped || (request.method !== 'GET' && request.method !== 'HEAD')) return;
        const claimed = classifyAgent(request.headers.get('user-agent'));
        const signed = request.headers.has('signature') && request.headers.has('signature-input') && request.headers.has('signature-agent');
        if (!claimed && !signed) return;
        const now = Date.now();
        const entry: Counted = { period: new Date(now).toISOString().slice(0, 10), path: cleanPath(request.url) };
        counted.set(request, entry);
        if (!signed) {
          entry.path = add(entry.period, entry.path, claimed!.agent, claimed!.kind, 1);
          entry.agent = claimed!;
          schedule(now, ctx);
          return;
        }
        // Counted once the signature is checked: as the signer's agent when it verifies, else by User-Agent.
        const settled = verifySignedAgent(request, now).then((signer) => {
          const agent = signer ?? claimed;
          if (!agent || stopped) return;
          entry.path = add(entry.period, entry.path, agent.agent, agent.kind, 1, entry.outcome, signer ? 1 : 0);
          entry.agent = agent;
          schedule(Date.now(), ctx);
        });
        ctx?.waitUntil(settled);
      } catch {
        // Counting must never break the site.
      }
    },
    observe(request, response, ctx) {
      try {
        const entry = counted.get(request);
        if (!entry || entry.observed || stopped) return;
        const outcome = classifyOutcome(request, response);
        if (!outcome) return;
        entry.observed = true;
        if (!entry.agent) { entry.outcome = outcome; return; } // applied when its signature check settles
        add(entry.period, entry.path, entry.agent.agent, entry.agent.kind, 0, outcome);
        schedule(Date.now(), ctx);
      } catch {
        // Counting must never break the site.
      }
    },
    flush,
  };
}
