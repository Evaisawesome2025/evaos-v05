#!/usr/bin/env python3
"""Offline helper checks. Usage: python3 -B check-helper.py /path/to/releases.

All settings and account identifiers below are synthetic. Network access fails
closed. No settings, environment values, credentials, or provider bodies are read.
The helper is executed from source without creating Python bytecode caches.
"""
import contextlib
import copy
import datetime
import email
import email.policy
import hashlib
import io
import json
import os
import pathlib
import subprocess
import sys
import types
from unittest.mock import patch

root = pathlib.Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else pathlib.Path(__file__).resolve().parents[2]
backend = root / 'evaos-v05'
expected_sha = 'c23ce45671e9d8bc9d153d65b277caae2f1513a2'
actual_sha = subprocess.check_output(['git', '-C', str(backend), 'rev-parse', 'HEAD'], text=True).strip()
assert actual_sha == expected_sha
path = backend / 'worker/tools/deploy-preserving.py'
mod = types.ModuleType('review_helper')
mod.__file__ = str(path)
with patch.dict(os.environ, {'CLOUDFLARE_ACCOUNT_ID': 'synthetic-account'}, clear=True):
    exec(compile(path.read_text(), str(path), 'exec'), mod.__dict__)

settings = {
    'compatibility_date': '2026-10-01',
    'compatibility_flags': ['nodejs_compat'],
    'observability': {'enabled': False},
    'bindings': [
        {'name': 'METERING_KV', 'type': 'kv_namespace', 'namespace_id': 'synthetic-meter'},
        {'name': 'OBJECTIVE', 'type': 'kv_namespace', 'namespace_id': 'synthetic-objective'},
        {'name': 'BOUNDARY', 'type': 'service', 'service': 'synthetic-boundary'},
        {'name': 'BOUNDARY_ORIGIN', 'type': 'plain_text', 'text': 'https://synthetic.invalid'},
        {'name': 'OWNER_BEARER', 'type': 'secret_text'},
        {'name': 'GH_PAT', 'type': 'secret_text'},
    ],
}
baseline = {'deployments': [{'versions': [{'version_id': 'previous'}]}], 'settings_sha256': mod.fingerprint(settings)}
original_read = pathlib.Path.read_text
results = []


def run(name, argv, versions, change_settings=False):
    writes, puts, hashes = [], [], {}
    version_iterator = iter(versions)
    get_settings = 0

    def read_text(p, *args, **kwargs):
        return json.dumps(baseline) if str(p) == '/synthetic-baseline.json' else original_read(p, *args, **kwargs)

    def fake_result(route):
        nonlocal get_settings
        if route == '/settings':
            get_settings += 1
            value = copy.deepcopy(settings)
            if change_settings and get_settings == 2:
                value['compatibility_date'] = '2026-10-02'
            return value
        if route == '/deployments':
            return {'deployments': [{'id': 'synthetic-release'}]}
        raise AssertionError(route)

    def fake_request(route, method='GET', data=None, content_type=None):
        assert route == '' and method == 'PUT'
        puts.append(method)
        msg = email.message_from_bytes(('Content-Type: ' + content_type + '\r\nMIME-Version: 1.0\r\n\r\n').encode() + data, policy=email.policy.default)
        for part in msg.iter_parts():
            name = part.get_param('name', header='content-disposition')
            content = part.get_payload(decode=True)
            if name == 'metadata':
                metadata = json.loads(content)
                for key, value in settings.items():
                    if key != 'bindings':
                        assert metadata[key] == value
                assert 'bindings' not in metadata
                assert metadata['keep_bindings'] == sorted({binding['type'] for binding in settings['bindings']})
            else:
                hashes[name] = hashlib.sha256(content).hexdigest()
        return b'{"success":true}', {}

    outcome = 'ok'
    with patch.object(pathlib.Path, 'read_text', read_text), \
         patch.object(pathlib.Path, 'write_text', lambda p, value, *a, **k: writes.append(json.loads(value))), \
         patch.object(mod, 'current_version', lambda: next(version_iterator)), \
         patch.object(mod, 'result', fake_result), \
         patch.object(mod, 'request', fake_request), \
         patch.object(mod, 'code_hash', lambda: hashes), \
         patch.object(mod.urllib.request.OpenerDirector, 'open', side_effect=AssertionError('Network forbidden')), \
         patch.object(sys, 'argv', ['helper', '--baseline', '/synthetic-baseline.json', '--output', '/synthetic-evidence.json'] + argv), \
         contextlib.redirect_stdout(io.StringIO()):
        try:
            mod.main()
        except SystemExit as error:
            outcome = str(error)
    if name == 'preflight':
        assert not puts and not writes[0]['published']
    elif name in ['publish', 'rollback']:
        assert len(puts) == 1 and writes[0]['settings_preserved'] and writes[0]['code_verified']
        assert len(hashes) == (1 if name == 'rollback' else 4)
    else:
        assert not puts and not writes and outcome.startswith('Stop:')
    results.append({'case': name, 'passed': True, 'simulatedUploads': len(puts)})


run('preflight', [], ['previous'])
run('publish', ['--publish'], ['previous', 'previous', 'new'])
run('rollback', ['--publish', '--rollback', '--expected-version', 'new'], ['new', 'new', 'rollback'])
run('version-drift', ['--publish'], ['concurrent'])
run('late-version-drift', ['--publish'], ['previous', 'concurrent'])
run('late-settings-drift', ['--publish'], ['previous', 'previous'], True)
print(json.dumps({'timestamp': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'testedBackendSource': actual_sha, 'status': 'pass', 'offlineHelperChecks': results, 'productionRequests': 0, 'helperFilesystemWrites': 0, 'limitation': 'Mocks verify local request construction and guards, not Cloudflare acceptance, current production provenance, or provider rollback behavior.'}, indent=2))
