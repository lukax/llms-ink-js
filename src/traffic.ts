/**
 * AI traffic: which AI agents fetch which pages of your site, counted in memory and sent to llms.ink as daily
 * aggregates (`POST /api/v0/traffic`). Only requests from the agents in {@link AI_AGENTS} are counted; what leaves
 * your server is `{ site, period, rows: [{ path, agent, kind, count }] }` — no IPs, no user agents, no query
 * strings, no cookies, nothing about people who visit.
 *
 * @module
 */

import { DEFAULT_BASE_URL, VERSION } from './index.ts';

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

/** Options for {@link trafficCounter}, and the middleware's `traffic` option. */
export interface TrafficOptions {
  /** API key (`lk_…`). Verify the hostname at llms.ink/traffic first; account keys share verified sites. */
  key: string;
  /** Hostname the counts are filed under, e.g. `example.com`. The middleware defaults it to its `site`. */
  site?: string;
  /** Seconds between sends. Default 60, at least 10. */
  flushEvery?: number;
}

/** One aggregate: requests from one agent to one path in one UTC day. */
export interface TrafficRow {
  path: string;
  agent: string;
  kind: AgentKind;
  count: number;
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
   * Counts the request when an AI agent sent it (`GET`/`HEAD` only). When a send is due it starts one and hands it
   * to `ctx.waitUntil`; without `ctx`, a background timer sends. Never throws and never waits.
   */
  record(request: Request, ctx?: WaitUntil): void;
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
  const every = Math.max(10, options.flushEvery ?? 60) * 1000;
  const endpoint = `${(options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')}/api/v0/traffic`;
  const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'user-agent': `llms-ink-js/${VERSION}` };

  /** `period\tpath\tagent` → row. */
  const pending = new Map<string, TrafficRow & { period: string }>();
  let queued: OutboundBatch[] = [];
  let lastSend = Date.now();
  let retryAt = 0;
  let backoff = 0;
  let inflight: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Set when llms.ink refuses the key or the site: counting stops, once, with a warning. */
  let stopped = false;

  function add(period: string, path: string, agent: string, kind: AgentKind, count: number) {
    let id = `${period}\t${path}\t${agent}`;
    let row = pending.get(id);
    if (!row && pending.size >= MAX_PENDING) {
      path = OTHER_PATH;
      id = `${period}\t${path}\t${agent}`;
      row = pending.get(id);
    }
    if (row) row.count += count;
    else pending.set(id, { period, path, agent, kind, count });
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
    retryAt = Date.now() + Math.max(backoff, (retryAfter ?? 0) * 1000);
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
    for (const { period, path, agent, kind, count } of pending.values()) {
      let rows = byPeriod.get(period); if (!rows) { rows = []; byPeriod.set(period, rows); }
      rows.push({ path, agent, kind, count });
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
    const delay = Math.max(1000, Math.max(lastSend + every, retryAt) - Date.now());
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
        const agent = classifyAgent(request.headers.get('user-agent'));
        if (!agent) return;
        const now = Date.now();
        add(new Date(now).toISOString().slice(0, 10), cleanPath(request.url), agent.agent, agent.kind, 1);
        const due = now - lastSend >= every || pending.size >= ROWS_PER_POST;
        if (!inflight && now >= retryAt && due) {
          const sending = flush();
          ctx?.waitUntil(sending);
        } else if (!ctx) {
          arm();
        }
      } catch {
        // Counting must never break the site.
      }
    },
    flush,
  };
}
