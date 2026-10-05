import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import worker from '../src/index.js';
import release from '../src/release.js';
import preserved from '../preserved/deployed-514bf8c7.js';
import { normalizeBrief, exportBrief, FIELDS } from '../src/brief-model.js';
const fixture = { objective: 'Compare two synthetic page drafts.', inputs: 'Two fictional page drafts supplied as text.', deliverable: 'One page comparing clarity and evidence.', constraints: 'No outreach, spending, or publishing.', success: 'Every claim names its source.\nOne tradeoff is stated.', stopRule: 'Stop after the draft and request human review.' };
const request = (body = JSON.stringify(fixture), headers = {}, method = 'POST') => new Request('https://example.test/brief/validate', { method, headers: { Origin: 'https://joinermill.com', 'Content-Type': 'application/json', ...headers }, ...(method === 'GET' || method === 'OPTIONS' ? {} : { body, ...(body instanceof ReadableStream ? { duplex: 'half' } : {}) }) });
const noAccess = new Proxy({}, { get() { throw new Error('No binding may be accessed'); } });
test('normalizes only surrounding whitespace, CRLF and checklist blank lines; keeps literal input', () => {
 const value = { ...fixture, objective: '  Compare <img src=x onerror=alert(1)> drafts.  ', success: '  A source is named.\r\n\r\n A tradeoff is stated. ' };
 const n = normalizeBrief(value); assert.equal(n.ok, true); assert.equal(n.brief.objective, value.objective.trim()); assert.equal(n.brief.success, 'A source is named.\nA tradeoff is stated.');
 assert.deepEqual(normalizeBrief(n.brief).brief, n.brief);
});
test('rejects invalid shapes, unknown keys, missing/nonstring/overlong/control fields and checklist boundaries', () => {
 for (const v of [null, [], 'text', 1, { ...fixture, extra: 'bad' }, { ...fixture, objective: null }]) assert.equal(normalizeBrief(v).ok, false);
 for (const [key, field] of Object.entries(FIELDS)) for (const text of ['', ' '.repeat(field.min), 'x'.repeat(field.max + 1), 'xx\u0000invalid']) assert.equal(normalizeBrief({ ...fixture, [key]: text }).ok, false, key);
 for (const success of ['a', 'x'.repeat(241), Array(13).fill('Check this.').join('\n')]) assert.equal(normalizeBrief({ ...fixture, success }).ok, false);
 assert.equal(normalizeBrief({ ...fixture, success: Array(12).fill('Check this.').join('\n') }).ok, true);
});
test('main and production entry generate exact text/hash without bindings or outbound fetch', async () => {
 const original = globalThis.fetch; globalThis.fetch = () => { throw new Error('No outbound fetch allowed'); };
 try { for (const entry of [worker, release]) {
  const r = await entry.fetch(request(), noAccess); assert.equal(r.status, 200);
  assert.equal(r.headers.get('Cache-Control'), 'no-store'); assert.equal(r.headers.get('X-Content-Type-Options'), 'nosniff');
  const out = await r.json(); assert.deepEqual(out.brief, fixture); assert.equal(out.exportText, exportBrief(fixture));
  assert.equal(out.sha256, createHash('sha256').update(out.exportText).digest('hex')); assert.equal(out.executed, false); assert.equal(out.validation, 'structure_only');
  assert.match(out.exportText, /\[ \] Every claim names its source\./); assert.match(out.exportText, /not executed/);
 }} finally { globalThis.fetch = original; }
});
test('CORS, methods, types, errors never reflect content', async () => {
 for (const [req, expected] of [[request('', {}, 'GET'),405], [request('{}', {Origin:'https://evil.example'}),403], [request('{}', {'Content-Type':'text/plain'}),415], [request('{invalid'),400], [request(JSON.stringify({ ...fixture, inputs: false })),422], [request(' '.repeat(32769)),413], [request('{}', {'Content-Length':'40000'}),413]]) {
  const r = await release.fetch(req, noAccess); assert.equal(r.status, expected); assert.equal(r.headers.get('Cache-Control'),'no-store');
  if (expected === 403) assert.equal(r.headers.get('Access-Control-Allow-Origin'), null);
 }
 const r = await release.fetch(request(null, {}, 'OPTIONS'), noAccess); assert.equal(r.status,204); assert.equal(r.headers.get('Access-Control-Allow-Origin'),'https://joinermill.com');
});
test('caps chunked input without Content-Length and rejects invalid UTF-8', async () => {
 const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(17000)); c.enqueue(new Uint8Array(17000)); c.close(); } });
 assert.equal((await release.fetch(request(body), noAccess)).status,413);
 assert.equal((await release.fetch(request(new Uint8Array([255,254])), noAccess)).status,400);
});
test('times out and cancels stalled stream', async () => {
 let cancelled = false; const body = new ReadableStream({ cancel() { cancelled=true; } });
 assert.equal((await release.fetch(request(body), noAccess)).status,408); assert.equal(cancelled,true);
});
test('bounded in-memory throttle returns retry hint', async () => {
 let response; for (let i=0;i<62;i++) response=await release.fetch(request('{}'),noAccess);
 assert.equal(response.status,429); assert.equal(response.headers.get('Retry-After'),'60');
});
test('captured module hash is exact and old routes delegate unchanged', async () => {
 assert.equal(createHash('sha256').update(fs.readFileSync(new URL('../preserved/deployed-514bf8c7.js',import.meta.url))).digest('hex'),'7976a5690e588c36f220b7b9e2fad588b57f9180da26cbfa823dfbe9497ab84f');
 for (const [method,path] of [['GET','/health'],['POST','/intent'],['POST','/metering/complete'],['POST','/objective/synthetic/close'],['GET','/missing'],['OPTIONS','/intent']]) {
  const a=await release.fetch(new Request('https://example.test'+path,{method}),{});const b=await preserved.fetch(new Request('https://example.test'+path,{method}),{});
  assert.equal(a.status,b.status,path);assert.equal(await a.text(),await b.text(),path);assert.deepEqual([...a.headers],[...b.headers],path);
 }
});
