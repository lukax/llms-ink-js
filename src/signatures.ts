/**
 * Web Bot Auth: verifies that a request was signed (RFC 9421 HTTP Message Signatures, Ed25519) by a key published
 * by one of the {@link SIGNED_AGENTS}. Only those exact signer origins are ever fetched, so a request can't make the
 * server fetch an address of its choosing. Profile: draft-ietf-webbotauth-httpsig-protocol.
 *
 * @module
 */

import type { AgentKind } from './traffic.ts';

/** An operator that signs its agents' requests, and the name its verified requests are counted under. */
export interface SignedAgent {
  /** The `Signature-Agent` origin; keys are read from its `/.well-known/http-message-signatures-directory`. */
  signer: string;
  agent: string;
  kind: AgentKind;
  operator: string;
}

/**
 * Signers whose directories are documented by their operators. These agents often send a browser User-Agent, so
 * only a signature identifies them.
 */
export const SIGNED_AGENTS: readonly SignedAgent[] = [
  { signer: 'https://chatgpt.com', agent: 'ChatGPT-Agent', kind: 'user', operator: 'OpenAI' },
  { signer: 'https://agent.bot.goog', agent: 'Google-Agent', kind: 'user', operator: 'Google' },
];

const WELL_KNOWN = '/.well-known/http-message-signatures-directory';
const BY_SIGNER = new Map(SIGNED_AGENTS.map((s) => [s.signer, s]));
/** Clock skew allowed before `created`, and the longest signature lifetime accepted (the draft recommends 24 h). */
const SKEW_S = 60;
const MAX_LIFETIME_S = 86_400;
const FETCH_TIMEOUT_MS = 3000;
const MAX_DIRECTORY_BYTES = 65_536;
const MAX_KEYS = 32;
/** Directory cache bounds, from `Cache-Control: max-age`; failures are retried after the minimum. */
const MIN_TTL_S = 300;
const MAX_TTL_S = 86_400;
const DEFAULT_TTL_S = 3600;

/* ── Structured fields (RFC 9651), the subset signatures use ─────────────────────────────────────────────────── */

class Token { constructor(readonly name: string) {} }
type Bare = number | string | boolean | Uint8Array<ArrayBuffer> | Token;
type Params = Map<string, Bare>;
interface Item { value: Bare; params: Params }
interface InnerList { items: Item[]; params: Params }
type Member = Item | InnerList;

/** Parses a Dictionary field; throws on anything malformed or unsupported (decimals, dates, display strings). */
function parseDictionary(input: string): Map<string, Member> {
  let i = 0;
  const s = input.trim();
  const fail = (): never => { throw new SyntaxError('structured field'); };
  const sp = () => { while (s[i] === ' ') i++; };
  const ows = () => { while (s[i] === ' ' || s[i] === '\t') i++; };
  const key = (): string => {
    const m = /^[a-z*][a-z0-9_\-.*]*/.exec(s.slice(i)) ?? fail();
    i += m[0].length;
    return m[0];
  };
  const bare = (): Bare => {
    const c = s[i];
    if (c === '-' || (c !== undefined && c >= '0' && c <= '9')) {
      const m = /^-?\d{1,15}(?![.\d])/.exec(s.slice(i)) ?? fail();
      i += m[0].length;
      return Number(m[0]);
    }
    if (c === '"') {
      let out = '';
      for (i++; ; i++) {
        const ch = s[i] ?? fail();
        if (ch === '\\') { const next = s[++i]; if (next !== '"' && next !== '\\') fail(); out += next; continue; }
        if (ch === '"') { i++; return out; }
        const code = ch.charCodeAt(0);
        if (code < 0x20 || code > 0x7e) fail();
        out += ch;
      }
    }
    if (c === ':') {
      const end = s.indexOf(':', i + 1);
      const b64 = end < 0 ? fail() : s.slice(i + 1, end);
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) fail();
      i = end + 1;
      return Uint8Array.from(atob(b64), (x) => x.charCodeAt(0));
    }
    if (c === '?') { const v = s[i + 1]; if (v !== '0' && v !== '1') fail(); i += 2; return v === '1'; }
    const m = /^[A-Za-z*][!#$%&'*+\-.^_`|~0-9A-Za-z:/]*/.exec(s.slice(i)) ?? fail();
    i += m[0].length;
    return new Token(m[0]);
  };
  const params = (): Params => {
    const out: Params = new Map();
    while (s[i] === ';') {
      i++; sp();
      const k = key();
      let v: Bare = true;
      if (s[i] === '=') { i++; v = bare(); }
      out.set(k, v);
    }
    return out;
  };
  const item = (): Item => ({ value: bare(), params: params() });
  const member = (): Member => {
    if (s[i] !== '(') return item();
    i++;
    const items: Item[] = [];
    for (;;) {
      sp();
      if (s[i] === ')') { i++; return { items, params: params() }; }
      items.push(item());
      if (s[i] !== ' ' && s[i] !== ')') fail();
    }
  };
  const out = new Map<string, Member>();
  while (i < s.length) {
    const k = key();
    if (s[i] === '=') { i++; out.set(k, member()); } else out.set(k, { value: true, params: params() });
    ows();
    if (i >= s.length) break;
    if (s[i++] !== ',') fail();
    ows();
    if (i >= s.length) fail();
  }
  return out;
}

const serializeBare = (v: Bare): string =>
  typeof v === 'number' ? String(v)
  : typeof v === 'string' ? `"${v.replace(/[\\"]/g, '\\$&')}"`
  : typeof v === 'boolean' ? (v ? '?1' : '?0')
  : v instanceof Token ? v.name
  : `:${btoa(String.fromCharCode(...v))}:`;
const serializeParams = (p: Params) => [...p].map(([k, v]) => (v === true ? `;${k}` : `;${k}=${serializeBare(v)}`)).join('');
const serializeItem = (it: Item) => serializeBare(it.value) + serializeParams(it.params);
const serializeMember = (m: Member) => ('items' in m ? `(${m.items.map(serializeItem).join(' ')})${serializeParams(m.params)}` : serializeItem(m));

/* ── Signature base (RFC 9421 §2) ─────────────────────────────────────────────────────────────────────────────── */

/** A covered component's value, or null when this verifier doesn't support it (the signature then fails). */
function componentValue(request: Request, url: URL, component: Item): string | null {
  if (typeof component.value !== 'string') return null;
  const name = component.value;
  const extra = [...component.params.keys()].filter((k) => k !== 'key');
  if (extra.length) return null;
  const key = component.params.get('key');
  if (name.startsWith('@')) {
    if (key !== undefined) return null;
    switch (name) {
      case '@method': return request.method.toUpperCase();
      case '@authority': return url.host.toLowerCase();
      case '@scheme': return url.protocol.slice(0, -1).toLowerCase();
      case '@target-uri': return url.href;
      case '@path': return url.pathname || '/';
      case '@query': return url.search || '?';
      case '@request-target': return (url.pathname || '/') + url.search;
      default: return null;
    }
  }
  const field = request.headers.get(name);
  if (field === null) return null;
  if (key === undefined) return field.trim();
  if (typeof key !== 'string') return null;
  const member = parseDictionary(field).get(key);
  return member ? serializeMember(member) : null;
}

/* ── Key directories ──────────────────────────────────────────────────────────────────────────────────────────── */

interface DirectoryKey { key: CryptoKey; nbf?: number; exp?: number }
interface Directory { keys: Map<string, DirectoryKey>; until: number }
const directories = new Map<string, Directory>();
const loading = new Map<string, Promise<Directory>>();

/** Node 18 has no global `crypto`, and `node:crypto` doesn't exist in Workers or browsers: it can't be a static import. */
async function subtle(): Promise<SubtleCrypto> {
  if (globalThis.crypto) return globalThis.crypto.subtle;
  const { webcrypto } = await import('node:crypto');
  // Node's webcrypto implements the same interface under its own type name.
  const nodeSubtle = webcrypto.subtle as SubtleCrypto;
  return nodeSubtle;
}

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Reads a signer's directory: Ed25519 keys by RFC 7638 thumbprint, computed here rather than trusted from `kid`. */
async function loadDirectory(signer: string, now: number): Promise<Directory> {
  const empty = (ttl = MIN_TTL_S): Directory => ({ keys: new Map(), until: now + ttl * 1000 });
  let res: Response;
  try {
    res = await fetch(signer + WELL_KNOWN, {
      headers: { accept: 'application/http-message-signatures-directory+json, application/json;q=0.9' },
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    return empty();
  }
  if (res.status !== 200) { await res.body?.cancel(); return empty(); }
  let text = '';
  try {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    for (let size = 0; ;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_DIRECTORY_BYTES) { await reader.cancel(); return empty(); }
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
  } catch {
    return empty();
  }
  let body: unknown;
  try { body = JSON.parse(text); } catch { return empty(); }
  if (!body || typeof body !== 'object' || !('keys' in body) || !Array.isArray(body.keys)) return empty();
  const crypto = await subtle();
  const keys = new Map<string, DirectoryKey>();
  for (const jwk of body.keys.slice(0, MAX_KEYS)) {
    if (!jwk || typeof jwk !== 'object' || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(jwk.x)) continue;
    try {
      const thumbprint = base64url(new Uint8Array(await crypto.digest('SHA-256', new TextEncoder().encode(`{"crv":"Ed25519","kty":"OKP","x":"${jwk.x}"}`))));
      const key = await crypto.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, { name: 'Ed25519' }, false, ['verify']);
      keys.set(thumbprint, { key, ...(typeof jwk.nbf === 'number' && { nbf: jwk.nbf }), ...(typeof jwk.exp === 'number' && { exp: jwk.exp }) });
    } catch {
      // A key this runtime can't import is skipped.
    }
  }
  // No usable key is a failure: retried after the minimum, never cached for the directory's lifetime.
  if (!keys.size) return empty();
  const maxAge = Number(/(?:^|,)\s*max-age=(\d+)/i.exec(res.headers.get('cache-control') ?? '')?.[1] ?? DEFAULT_TTL_S);
  return { keys, until: now + Math.min(MAX_TTL_S, Math.max(MIN_TTL_S, maxAge)) * 1000 };
}

/** The cached directory, refreshed after its lifetime; concurrent requests share one fetch. */
async function directory(signer: string, now: number): Promise<Directory> {
  const cached = directories.get(signer);
  if (cached && now < cached.until) return cached;
  let pending = loading.get(signer);
  if (!pending) {
    pending = loadDirectory(signer, now).then((d) => { directories.set(signer, d); return d; }).finally(() => loading.delete(signer));
    loading.set(signer, pending);
  }
  return pending;
}

/** The known signer a `Signature-Agent` member names: its origin, or that origin's well-known directory URL. */
function knownSigner(value: Bare): SignedAgent | null {
  if (typeof value !== 'string') return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || (url.pathname !== '/' && url.pathname !== WELL_KNOWN)) return null;
  return BY_SIGNER.get(url.origin) ?? null;
}

/**
 * The {@link SignedAgent} whose published key produced a valid Web Bot Auth signature on `request`, or null.
 * Never throws. Requires `tag="web-bot-auth"`, `created`/`expires` around `now` (lifetime at most 24 hours), a
 * covered `@authority` or `@target-uri`, and the covered `Signature-Agent` member naming a known signer. A valid
 * signature can be replayed until it expires; this identifies the operator, not a person or a permission.
 */
export async function verifySignedAgent(request: Request, now: number = Date.now()): Promise<SignedAgent | null> {
  try {
    const inputs = request.headers.get('signature-input'), sigs = request.headers.get('signature'), agents = request.headers.get('signature-agent');
    if (!inputs || !sigs || !agents) return null;
    const url = new URL(request.url);
    const signatures = parseDictionary(sigs);
    // Legacy senders put a bare String in Signature-Agent; it stands for the one signature that covers it.
    const legacy = agents.trim().startsWith('"');
    const agentMembers = legacy ? null : parseDictionary(agents);
    for (const [label, input] of parseDictionary(inputs)) {
      if (!('items' in input)) continue;
      const p = input.params, created = p.get('created'), expires = p.get('expires'), keyid = p.get('keyid'), alg = p.get('alg');
      if (p.get('tag') !== 'web-bot-auth' || typeof keyid !== 'string' || typeof created !== 'number' || typeof expires !== 'number') continue;
      if (alg !== undefined && alg !== 'ed25519') continue;
      const seconds = now / 1000;
      if (created > seconds + SKEW_S || expires <= seconds || expires <= created || expires - created > MAX_LIFETIME_S) continue;
      const names = input.items.map((c) => c.value);
      if (!names.includes('@authority') && !names.includes('@target-uri')) continue;
      const agentComponent = input.items.find((c) => c.value === 'signature-agent');
      if (!agentComponent) continue;
      let signerValue: Bare | undefined;
      if (legacy) {
        if (agentComponent.params.size) continue;
        const member = parseDictionary(`x=${agents.trim()}`).get('x');
        signerValue = member && !('items' in member) && !member.params.size ? member.value : undefined;
      } else {
        const memberKey = agentComponent.params.get('key');
        if (typeof memberKey !== 'string' || memberKey !== label) continue;
        const member = agentMembers!.get(memberKey);
        if (!member || 'items' in member || member.params.size) continue;
        signerValue = member.value;
      }
      const signer = signerValue === undefined ? null : knownSigner(signerValue);
      const signature = signatures.get(label);
      if (!signer || !signature || 'items' in signature || !(signature.value instanceof Uint8Array)) continue;
      const lines: string[] = [];
      const seen = new Set<string>();
      let supported = true;
      for (const component of input.items) {
        const id = serializeItem(component);
        const value = seen.has(id) ? null : componentValue(request, url, component);
        if (value === null || /[\r\n]/.test(value)) { supported = false; break; }
        seen.add(id);
        lines.push(`${id}: ${value}`);
      }
      if (!supported) continue;
      lines.push(`"@signature-params": ${serializeMember(input)}`);
      const entry = (await directory(signer.signer, now)).keys.get(keyid);
      if (!entry || (entry.nbf !== undefined && seconds < entry.nbf) || (entry.exp !== undefined && seconds >= entry.exp)) continue;
      const ok = await (await subtle()).verify({ name: 'Ed25519' }, entry.key, signature.value, new TextEncoder().encode(lines.join('\n')));
      if (ok) return signer;
    }
  } catch {
    // Malformed fields, unsupported components or crypto failures: not verified.
  }
  return null;
}
