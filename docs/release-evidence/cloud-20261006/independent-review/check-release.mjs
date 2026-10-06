// Offline independent release checks. Usage: node check-release.mjs /path/to/releases
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(process.argv[2] || resolve(dirname(fileURLToPath(import.meta.url)), '../..'));
const frontend = resolve(root, 'joinermill');
const backend = resolve(root, 'evaos-v05');
const expected = {
  frontend: 'ad0af760bae86702526bd935ff6fc5fc17a172f9',
  backend: 'c23ce45671e9d8bc9d153d65b277caae2f1513a2'
};
const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
assert.equal(git(frontend, ['rev-parse', 'HEAD']), expected.frontend);
assert.equal(git(backend, ['rev-parse', 'HEAD']), expected.backend);
for (const ancestor of ['4123538bf18c4eb322c20247e23656625df40169', '6a03b5da0d3d8103a87c6df3e69e71e227b4be5e', '633d4afd1bf5e2586fbf0deda7dab6ec9f09432d', 'a30ccbe', '7f78c54097d70dc46d2d51b45f5e3d513f88fe67']) {
  git(frontend, ['merge-base', '--is-ancestor', ancestor, 'HEAD']);
}
for (const ancestor of ['c15db296c5a7dbf2cb5df40ba8fbe9443e578570', 'd39936927821ce80087194eec948c7d94857037b']) {
  git(backend, ['merge-base', '--is-ancestor', ancestor, 'HEAD']);
}
const frontendModel = readFileSync(resolve(frontend, 'preview/brief-model.js'));
const backendModel = readFileSync(resolve(backend, 'worker/src/brief-model.js'));
assert.ok(frontendModel.equals(backendModel));
const preservedPath = resolve(backend, 'worker/preserved/deployed-514bf8c7.js');
const preservedSha = createHash('sha256').update(readFileSync(preservedPath)).digest('hex');
assert.equal(preservedSha, '7976a5690e588c36f220b7b9e2fad588b57f9180da26cbfa823dfbe9497ab84f');
const { default: release } = await import(pathToFileURL(resolve(backend, 'worker/src/release.js')));
const { default: preserved } = await import(pathToFileURL(preservedPath));
const originalDelegatedFetch = preserved.fetch;
const originalNetworkFetch = globalThis.fetch;
let delegated = 0;
let expectedRequest;
const noBindings = new Proxy({}, { get() { throw Error('Unexpected binding access'); } });
const ctx = { waitUntil() { throw Error('Unexpected background work'); } };
globalThis.fetch = () => { throw Error('Unexpected outbound fetch'); };
try {
  preserved.fetch = (req, env, context) => {
    assert.equal(req, expectedRequest);
    assert.equal(env, noBindings);
    assert.equal(context, ctx);
    delegated++;
    return new Response('sentinel', { status: 202 });
  };
  for (const method of ['GET', 'HEAD', 'POST', 'OPTIONS', 'DELETE', 'PATCH']) {
    for (const path of ['/health', '/intent', '/metering/complete', '/objective', '/objective/synthetic', '/objective/synthetic/close', '/objective/synthetic/claim', '/objective/synthetic/act', '/unrecognized', '/brief/validate/', '/brief/Validate']) {
      expectedRequest = new Request('https://example.test' + path, { method });
      const response = await release.fetch(expectedRequest, noBindings, ctx);
      assert.equal(response.status, 202);
    }
  }
  const fixture = { objective: 'Compare synthetic release fixtures.', inputs: 'Fictional A and B.', deliverable: 'One review note.', constraints: 'No execution or storage.', success: 'One source named.', stopRule: 'Stop for human review.' };
  for (const origin of [null, 'https://joinermill.com', 'https://www.joinermill.com', 'https://evaisawesome2025.github.io']) {
    const headers = { 'Content-Type': 'application/json' };
    if (origin) headers.Origin = origin;
    const response = await release.fetch(new Request('https://example.test/brief/validate?review=synthetic', { method: 'POST', headers, body: JSON.stringify(fixture) }), noBindings, ctx);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(Object.keys(body.brief), Object.keys(fixture));
    assert.deepEqual(body.brief, fixture);
    assert.equal(body.executed, false);
    assert.equal(body.validation, 'structure_only');
    assert.equal(body.sha256, createHash('sha256').update(body.exportText).digest('hex'));
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
  }
  assert.equal(delegated, 66);
} finally {
  preserved.fetch = originalDelegatedFetch;
  globalThis.fetch = originalNetworkFetch;
}
console.log(JSON.stringify({ timestamp: new Date().toISOString(), testedSource: expected, status: 'pass', ancestryChecks: 7, sharedModelByteIdentical: true, preservedModuleSha256: preservedSha, exactRequestEnvironmentContextDelegations: delegated, statelessValidationOriginCases: 4, outboundFetches: 0, bindingAccesses: 0 }, null, 2));
