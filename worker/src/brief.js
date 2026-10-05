import { normalizeBrief, exportBrief, digestText } from './brief-model.js';
const ORIGINS = new Set(['https://joinermill.com', 'https://www.joinermill.com', 'https://evaisawesome2025.github.io', 'http://127.0.0.1:8765', 'http://localhost:8765']);
const MAX_BYTES = 32768;
let windowStart = 0, count = 0;
function headers(origin) {
  return { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Origin',
    ...(ORIGINS.has(origin) ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' } : {}) };
}
async function boundedJson(request) {
  const length = request.headers.get('Content-Length');
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) throw 413;
  if (!request.body) throw 400;
  const reader = request.body.getReader();
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const chunks = []; let size = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_BYTES) throw 413;
          chunks.push(value);
        }
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw 400; }
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(408), 3000); })
    ]);
  } finally { clearTimeout(timer); reader.cancel().catch(() => {}); }
}
export async function handleBrief(request) {
  const origin = request.headers.get('Origin') || '';
  const reply = (status, data, extra = {}) => new Response(data === null ? null : JSON.stringify(data), { status, headers: { ...headers(origin), ...extra } });
  if (origin && !ORIGINS.has(origin)) return reply(403, { ok: false, error: 'origin_not_allowed' });
  if (request.method === 'OPTIONS') return reply(204, null);
  if (request.method !== 'POST') return reply(405, { ok: false, error: 'method_not_allowed' }, { Allow: 'POST, OPTIONS' });
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('Content-Type') || '')) return reply(415, { ok: false, error: 'json_required' });
  // Fixed-size best-effort per-isolate bucket; no IP storage or durable state.
  const now = Date.now();
  if (now - windowStart >= 60000) { windowStart = now; count = 0; }
  if (++count > 60) return reply(429, { ok: false, error: 'try_later' }, { 'Retry-After': '60' });
  let input;
  try { input = await boundedJson(request); } catch (status) {
    const code = [400, 408, 413].includes(status) ? status : 400;
    return reply(code, { ok: false, error: ({ 400: 'invalid_json', 408: 'request_timeout', 413: 'body_too_large' })[code] });
  }
  const result = normalizeBrief(input);
  if (!result.ok) return reply(422, result);
  const text = exportBrief(result.brief);
  return reply(200, { ok: true, schema_version: 1, kind: 'deterministic_work_brief', executed: false, validation: 'structure_only', brief: result.brief, exportText: text, sha256: await digestText(text) });
}
