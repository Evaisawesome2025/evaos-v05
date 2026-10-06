"""Offline regression tests for the version-only release helper.

Run: python3 -B -m unittest discover -s test -p 'deploy_preserving_test.py' -v
All provider settings and identifiers are synthetic; network calls fail closed.
"""
import contextlib
import copy
import email
import email.policy
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

WORKER = Path(__file__).resolve().parents[1]
HELPER = WORKER / 'tools/deploy-preserving.py'
OLD = '11111111-1111-4111-8111-111111111111'
NEW = '22222222-2222-4222-8222-222222222222'
OTHER = '33333333-3333-4333-8333-333333333333'


def load_helper():
    module = types.ModuleType('deploy_preserving_under_test')
    module.__file__ = str(HELPER)
    exec(compile(HELPER.read_text(), str(HELPER), 'exec'), module.__dict__)
    return module


class Provider:
    def __init__(self, helper, scenario='ok'):
        self.helper, self.scenario, self.calls = helper, scenario, []
        self.deployment = {'id': 'original-deployment', 'versions': [{'version_id': OLD, 'percentage': 100}]}
        self.settings = {
            'compatibility_date': '2026-10-01', 'compatibility_flags': [],
            'usage_model': 'standard', 'placement': {'mode': 'off'}, 'annotations': {},
            'logpush': False, 'tags': None, 'tail_consumers': None,
            'bindings': [
                {'name': 'OBJECTIVE', 'type': 'kv_namespace', 'namespace_id': 'synthetic-objective'},
                {'name': 'BOUNDARY', 'type': 'service', 'service': 'synthetic-boundary'},
                {'name': 'OWNER_BEARER', 'type': 'secret_text'},
            ],
        }
        self.script_settings = {'logpush': False, 'observability': None, 'tags': None, 'tail_consumers': None}
        self.original_settings, self.original_script = copy.deepcopy(self.settings), copy.deepcopy(self.script_settings)
        self.runtime = {'compatibility_date': '2026-10-01', 'compatibility_flags': [], 'usage_model': 'standard'}
        self.original_files = {'index.js': (WORKER / helper.FILES[-1]).read_bytes()}
        self.files, self.uploaded_files = self.original_files.copy(), {}
        self.current_reads, self.rollback_calls, self.activations = 0, 0, 0
        self.upload_metadata = None
        self.baseline = {
            'deployments': [copy.deepcopy(self.deployment)],
            'settings_sha256': helper.fingerprint(self.settings),
            'script_settings_sha256': helper.fingerprint(self.script_settings),
            'current_module_hashes': self.hashes(self.files),
        }

    @staticmethod
    def hashes(files):
        return {name: hashlib.sha256(body).hexdigest() for name, body in files.items()}

    def version(self, identity):
        resources = {'bindings': copy.deepcopy(self.original_settings['bindings']), 'script_runtime': copy.deepcopy(self.runtime)}
        if identity == NEW and self.scenario == 'staged-resource-drift':
            resources['script_runtime']['compatibility_date'] = '2026-10-02'
        return {'id': identity, 'resources': resources}

    @staticmethod
    def response(value):
        return json.dumps({'success': True, 'result': value}).encode(), {'Content-Type': 'application/json'}

    def code_response(self):
        boundary = 'synthetic-source-boundary'
        parts = []
        for name, value in self.files.items():
            parts.append((f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; filename="{name}"\r\nContent-Type: application/javascript+module\r\n\r\n').encode() + value + b'\r\n')
        parts.append(f'--{boundary}--\r\n'.encode())
        return b''.join(parts), {'Content-Type': f'multipart/form-data; boundary={boundary}'}

    def request(self, path, method='GET', data=None, content_type=None):
        self.calls.append((method, path))
        assert '?' not in path, 'No force or other query overrides allowed'
        if method == 'GET':
            if path == '/deployments':
                self.current_reads += 1
                # Read 9 begins the guarded rollback capture after postflight.
                if self.current_reads == 9 and self.scenario == 'concurrent-before-rollback':
                    self.deployment = {'id': 'concurrent-deployment', 'versions': [{'version_id': OTHER, 'percentage': 100}]}
                if self.current_reads == 9 and self.scenario == 'same-version-settings-before-rollback':
                    self.settings['compatibility_date'] = '2026-10-03'
                if self.current_reads == 9 and self.scenario == 'same-version-script-before-rollback':
                    self.script_settings['logpush'] = True
                return self.response({'deployments': [copy.deepcopy(self.deployment)]})
            if path == '/settings':
                return self.response(copy.deepcopy(self.settings))
            if path == '/script-settings':
                return self.response(copy.deepcopy(self.script_settings))
            if path == '':
                return self.code_response()
            if path in ['/versions/' + OLD, '/versions/' + NEW]:
                return self.response(self.version(path.rsplit('/', 1)[1]))
            raise AssertionError((method, path))
        if (method, path) == ('POST', '/versions'):
            msg = email.message_from_bytes(('Content-Type: ' + content_type + '\r\nMIME-Version: 1.0\r\n\r\n').encode() + data, policy=email.policy.default)
            for part in msg.iter_parts():
                name = part.get_param('name', header='content-disposition')
                body = part.get_payload(decode=True)
                if name == 'metadata':
                    self.upload_metadata = json.loads(body)
                else:
                    self.uploaded_files[name] = body
            assert not self.helper.SCRIPT_KEYS.intersection(self.upload_metadata)
            assert self.upload_metadata['bindings'] == [{'name': b['name'], 'type': 'inherit', 'version_id': OLD} for b in self.original_settings['bindings']]
            assert self.files == self.original_files, 'Uploading a version must not change traffic/code'
            if self.scenario == 'missing-upload-id':
                return self.response({})
            if self.scenario == 'preactivate-version-drift':
                self.deployment = {'id': 'concurrent-deployment', 'versions': [{'version_id': OTHER, 'percentage': 100}]}
            if self.scenario == 'preactivate-settings-drift':
                self.settings['compatibility_date'] = '2026-10-02'
            if self.scenario == 'preactivate-script-drift':
                self.script_settings['logpush'] = True
            if self.scenario == 'preactivate-code-drift':
                self.files = {'index.js': b'synthetic concurrent code'}
            return self.response(self.version(NEW))
        if (method, path) == ('POST', '/deployments'):
            payload = json.loads(data)
            target = payload['versions'][0]['version_id']
            assert payload == {'strategy': 'percentage', 'versions': [{'version_id': target, 'percentage': 100}]}
            if target == NEW:
                self.activations += 1
                self.deployment = {'id': 'owned-deployment', 'versions': payload['versions']}
                self.files = self.uploaded_files.copy()
                if self.scenario == 'ambiguous-activation':
                    raise self.helper.ReleaseError('Synthetic ambiguous activation response')
                if self.scenario == 'mismatched-activation-identity':
                    return self.response({'id': 'unknown-deployment', 'versions': [{'version_id': OTHER, 'percentage': 100}]})
                if self.scenario in ['post-code-drift', 'concurrent-before-rollback', 'same-version-settings-before-rollback', 'same-version-script-before-rollback', 'rollback-refused']:
                    self.files = {'unexpected.js': b'synthetic broken uploaded code'}
                if self.scenario == 'post-settings-drift':
                    self.settings['compatibility_date'] = '2026-10-02'
                if self.scenario == 'post-script-drift':
                    self.script_settings['logpush'] = True
                if self.scenario == 'concurrent-after-activation':
                    result = copy.deepcopy(self.deployment)
                    self.deployment = {'id': 'concurrent-deployment', 'versions': [{'version_id': OTHER, 'percentage': 100}]}
                    return self.response(result)
            elif target == OLD:
                self.rollback_calls += 1
                if self.scenario == 'rollback-refused':
                    raise self.helper.ReleaseError('Synthetic provider rollback refusal')
                self.deployment = {'id': 'restored-deployment', 'versions': payload['versions']}
                self.files = self.original_files.copy()
                self.settings = copy.deepcopy(self.original_settings)
            else:
                raise AssertionError('Unexpected target version')
            return self.response(copy.deepcopy(self.deployment))
        raise AssertionError('Mutation outside the approved version-only scope')


class ReleaseHelperTests(unittest.TestCase):
    def run_helper(self, scenario='ok', publish=True, rollback=False, expected=NEW):
        helper = load_helper()
        provider = Provider(helper, scenario)
        release = None
        if rollback:
            provider.deployment = {'id': 'owned-deployment', 'versions': [{'version_id': NEW, 'percentage': 100}]}
            provider.files = {name: (WORKER / name).read_bytes() for name in helper.FILES}
            release = {'after_deployment': copy.deepcopy(provider.deployment), 'files': provider.hashes(provider.files)}
            if scenario == 'standalone-script-drift':
                provider.script_settings['logpush'] = True
        with tempfile.TemporaryDirectory(prefix='synthetic-release-test-') as directory:
            baseline, output, receipt = [Path(directory) / name for name in ['baseline.json', 'output.json', 'release.json']]
            baseline.write_text(json.dumps(provider.baseline))
            args = ['helper', '--baseline', str(baseline), '--output', str(output)]
            if publish:
                args.append('--publish')
            if rollback:
                receipt.write_text(json.dumps(release))
                args += ['--rollback', '--expected-version', expected, '--release-evidence', str(receipt)]
            exit_code = 0
            with patch.object(helper, 'request', provider.request), patch.object(sys, 'argv', args), patch.object(helper.urllib.request.OpenerDirector, 'open', side_effect=AssertionError('Network forbidden')), contextlib.redirect_stdout(io.StringIO()):
                try:
                    helper.main()
                except SystemExit as error:
                    exit_code = error.code
            evidence = json.loads(output.read_text())
        # Evidence must never serialize the fixture's raw resource values.
        text = json.dumps(evidence)
        self.assertNotIn('synthetic-objective', text)
        self.assertNotIn('synthetic-boundary', text)
        self.assertNotIn('bindings', evidence)
        self.assertFalse(any(method in ['PUT', 'PATCH', 'DELETE'] for method, _ in provider.calls))
        return provider, evidence, exit_code

    def test_preflight_is_read_only(self):
        provider, evidence, code = self.run_helper(publish=False)
        self.assertEqual(code, 0)
        self.assertTrue(all(method == 'GET' for method, _ in provider.calls))
        self.assertFalse(evidence['write_attempted'])

    def test_success_stages_then_deploys_exact_version(self):
        provider, evidence, code = self.run_helper()
        self.assertEqual(code, 0)
        self.assertEqual([(m, p) for m, p in provider.calls if m != 'GET'], [('POST', '/versions'), ('POST', '/deployments')])
        self.assertEqual(evidence['after_version'], NEW)
        self.assertTrue(evidence['code_verified'] and evidence['settings_preserved'] and evidence['script_settings_preserved'])
        self.assertEqual(provider.script_settings, provider.original_script)

    def test_upload_identity_or_resources_must_be_confirmed(self):
        for scenario in ['missing-upload-id', 'staged-resource-drift']:
            with self.subTest(scenario=scenario):
                provider, evidence, code = self.run_helper(scenario)
                self.assertEqual(code, 1)
                self.assertEqual(provider.activations, 0)
                self.assertFalse(evidence['published'])

    def test_preactivation_drift_refuses_activation(self):
        for scenario in ['preactivate-version-drift', 'preactivate-settings-drift', 'preactivate-script-drift', 'preactivate-code-drift']:
            with self.subTest(scenario=scenario):
                provider, evidence, code = self.run_helper(scenario)
                self.assertEqual(code, 1)
                self.assertEqual(provider.activations, 0)
                self.assertFalse(evidence['published'])

    def test_ambiguous_activation_has_no_blind_followup_write(self):
        for scenario in ['ambiguous-activation', 'mismatched-activation-identity']:
            with self.subTest(scenario=scenario):
                provider, evidence, code = self.run_helper(scenario)
                self.assertEqual(code, 1)
                self.assertEqual(provider.activations, 1)
                self.assertEqual(provider.rollback_calls, 0)
                self.assertTrue(evidence['activation_attempted'])

    def test_owned_postflight_failure_restores_actual_baseline_version(self):
        for scenario in ['post-code-drift', 'post-settings-drift']:
            with self.subTest(scenario=scenario):
                provider, evidence, code = self.run_helper(scenario)
                self.assertEqual(code, 1)
                self.assertEqual(provider.rollback_calls, 1)
                self.assertTrue(evidence['rollback_verified'])
                self.assertEqual(provider.files, provider.original_files)
                self.assertEqual(provider.settings, provider.original_settings)

    def test_concurrent_or_script_drift_never_triggers_rollback(self):
        for scenario in ['concurrent-after-activation', 'concurrent-before-rollback', 'same-version-settings-before-rollback', 'same-version-script-before-rollback', 'post-script-drift']:
            with self.subTest(scenario=scenario):
                provider, evidence, code = self.run_helper(scenario)
                self.assertEqual(code, 1)
                self.assertEqual(provider.rollback_calls, 0)
                self.assertNotIn('rollback_verified', evidence)

    def test_provider_rollback_refusal_does_not_force_or_retry(self):
        provider, evidence, code = self.run_helper('rollback-refused')
        self.assertEqual(code, 1)
        self.assertEqual(provider.rollback_calls, 1)
        self.assertNotIn('rollback_verified', evidence)

    def test_standalone_rollback_selects_exact_baseline(self):
        provider, evidence, code = self.run_helper(rollback=True)
        self.assertEqual(code, 0)
        self.assertEqual(provider.activations, 0)
        self.assertEqual(provider.rollback_calls, 1)
        self.assertTrue(evidence['rollback_verified'])

    def test_standalone_rollback_requires_identity_and_unchanged_script_settings(self):
        for scenario, expected in [('ok', OTHER), ('standalone-script-drift', NEW)]:
            with self.subTest(scenario=scenario):
                provider, evidence, code = self.run_helper(scenario, rollback=True, expected=expected)
                self.assertEqual(code, 1)
                self.assertTrue(all(method == 'GET' for method, _ in provider.calls))

    def test_request_scope_rejects_non_version_writes_before_network(self):
        helper = load_helper()
        with patch.dict(os.environ, {'CLOUDFLARE_ACCOUNT_ID': helper.ACCOUNT, 'HTTPS_PROXY': 'http://synthetic.invalid', 'CLOUDFLARE_API_TOKEN': 'synthetic-placeholder'}, clear=True), patch.object(helper.urllib.request.OpenerDirector, 'open', side_effect=AssertionError('Network forbidden')):
            for method, path in [('PUT', ''), ('PATCH', '/script-settings'), ('DELETE', '/versions/' + NEW), ('POST', '/deployments?force=true')]:
                with self.subTest(method=method, path=path), self.assertRaises(helper.ReleaseError):
                    helper.request(path, method)


if __name__ == '__main__':
    unittest.main()
