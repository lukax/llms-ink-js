/** Hosted Inspect pilot. Only explicit inspect() calls upload content. */
export interface InspectionReceipt {
  readonly detection: 'no_finding' | 'flagged' | 'unknown';
  readonly coverage: 'complete' | 'partial' | 'none';
  readonly recommendation: 'continue' | 'withhold';
  readonly reason: string;
  readonly modelRevision: string;
  readonly policyRevision: string;
  readonly preprocessingRevision: string;
  readonly contentDigest: string;
  readonly inputTokens: number;
  readonly inspectedTokens: number;
  readonly windows: number;
  readonly enforced: false;
}

export async function prepareInspection(text: string, baseUrl: string): Promise<{body: string; digest: string}> {
  const url = new URL(baseUrl);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))) throw new TypeError('Inspect requires HTTPS (or localhost for development).');
  if (typeof text !== 'string' || !text.length) throw new TypeError('Inspect requires nonempty text.');
  const bytes = new TextEncoder().encode(text);
  if (new TextDecoder('utf-8', {ignoreBOM:true}).decode(bytes) !== text) throw new TypeError('Inspect requires valid Unicode.');
  const body = JSON.stringify({format:'text', content:text});
  if (new TextEncoder().encode(body).length > 131072) throw new TypeError('Inspect request exceeds 128 KiB after JSON encoding.');
  const crypto = globalThis.crypto ?? (await import('node:crypto')).webcrypto;
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2,'0')).join('');
  return {body, digest};
}

export async function inspectionJson(res: Response): Promise<unknown> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error('Inspect returned an empty response.');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const {value, done} = await reader.read(); if(done) break;
      size += value.length;
      if(size > 16384) { await reader.cancel(); throw new Error('Inspect response exceeds 16 KiB.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(bytes));
}

export function inspectionReceipt(value: unknown, digest: string, status: number): InspectionReceipt {
  const fail = () => { throw new Error('Inspect returned an invalid or unsupported receipt. Withhold the content.'); };
  if (!value || typeof value !== 'object') return fail();
  const r = value as InspectionReceipt;
  if (![200,422,503].includes(status) || (status !== 200 && r.detection !== 'unknown') || r.contentDigest !== digest || r.modelRevision !== '4a43fec65a670e48835d8e8c85c705b4b0d1c907' || r.policyRevision !== 'llms-ink-inspect-1' || r.preprocessingRevision !== 'utf8-json-stringify-1' || r.enforced !== false) return fail();
  if (!Number.isSafeInteger(r.inputTokens) || r.inputTokens < 0 || !Number.isSafeInteger(r.inspectedTokens) || r.inspectedTokens < 0 || r.inspectedTokens > r.inputTokens || !Number.isInteger(r.windows) || r.windows < 0 || r.windows > 43) return fail();
  let valid = false;
  if (r.detection === 'no_finding') valid = r.coverage === 'complete' && r.recommendation === 'continue' && r.reason === 'no_finding' && r.inputTokens <= 8192 && r.inspectedTokens === r.inputTokens && (r.inputTokens === 0 || r.windows > 0);
  if (r.detection === 'flagged') valid = ['complete','partial'].includes(r.coverage) && r.recommendation === 'withhold' && ['instruction_pattern','model_detection'].includes(r.reason) && r.inputTokens <= 8192 && r.inspectedTokens > 0 && r.windows > 0 && (r.coverage !== 'complete' || r.inspectedTokens === r.inputTokens);
  if (r.detection === 'unknown') valid = r.coverage === 'none' && r.recommendation === 'withhold' && r.inspectedTokens === 0 && r.windows === 0 && ['token_limit','model_unavailable','model_failure','inspection_timeout'].includes(r.reason);
  if (!valid) return fail();
  const {detection,coverage,recommendation,reason,modelRevision,policyRevision,preprocessingRevision,contentDigest,inputTokens,inspectedTokens,windows,enforced} = r;
  return Object.freeze({detection,coverage,recommendation,reason,modelRevision,policyRevision,preprocessingRevision,contentDigest,inputTokens,inspectedTokens,windows,enforced});
}
