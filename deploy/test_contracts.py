"""Shared Go/Python/browser contract fixtures; no processes or private profiles."""

import copy
import io
import json
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import remote_provider as contract
import supervisor
from providers import common


ROOT = Path(__file__).resolve().parents[1] / 'testdata/contracts'


def read(name):
    return json.loads((ROOT / name).read_text())


def payload(case, fallback):
    value = read(case.get('fixture', fallback))
    for change in case.get('changes', []):
        parts = change['path'].split('.')
        parent = value
        for part in parts[:-1]:
            parent = parent[int(part)] if isinstance(parent, list) else parent[part]
        key = parts[-1]
        if change.get('remove'):
            del parent[key]
        elif 'copies' in change:
            parent[key] = [copy.deepcopy(parent[key][0]) for _ in range(change['copies'])]
        else:
            parent[key] = change['value']
    return value


class SharedContractTest(unittest.TestCase):
    def test_supervisor_produces_shared_current_snapshot_without_side_effects(self):
        with tempfile.TemporaryDirectory() as root:
            config = {'version': 1, 'profile': root, 'relay_url': 'http://127.0.0.1:8787',
                      'gateway_url': 'http://127.0.0.1:8788', 'components': {},
                      **{key: str(Path(root) / key) for key in
                         ('relay_token_file', 'local_token_file', 'relay_state_file')}}
            subject = supervisor.Supervisor(config)
            self.addCleanup(subject.stop.set)
            with patch.object(supervisor, 'stamp', return_value='2026-11-01T12:00:00Z'):
                self.assertEqual(subject.snapshot(), read('supervisor-v2.json'))
            self.assertEqual(subject.children, {})

    def test_provider_metadata_and_browser_remote_constraints_agree(self):
        for case in read('system-cases.json'):
            changes = case.get('changes', [])
            if not changes or not all(c['path'].startswith('remote.') for c in changes):
                continue
            with self.subTest(case=case['name']):
                remote = payload(case, 'system-v2.json')['remote']
                metadata = {key: value for key, value in remote.items() if key != 'host_state'}
                if case['valid']:
                    self.assertEqual(contract.validate_result('describe', metadata), metadata)
                    contract.validate_result('status', {'host_state': remote['host_state']})
                else:
                    with self.assertRaises(contract.ProviderError):
                        contract.validate_result('describe', metadata)
                        contract.validate_result('status', {'host_state': remote['host_state']})

    def test_executable_provider_consumes_response_fixtures(self):
        spec = {'command': ['/sanitized/provider'], 'config_file': '/sanitized/provider.json'}
        for case in read('provider-cases.json'):
            if case['boundary'] != 'response':
                continue
            with self.subTest(case=case['name']):
                value = payload(case, 'provider-describe-v1.json')
                client = contract.ExecutableProvider(spec, 'http://127.0.0.1:8787', threading.Event())
                client.metadata['capabilities'] = list(contract.CAPABILITIES)
                method = case['method']
                params = {'expected_state_id': 'a' * 64} if method in ('relay.ensure', 'relay.restart') else {}
                with patch.object(contract, 'private_json', return_value={}), \
                        patch.object(contract.secrets, 'token_hex', return_value='contract-provider-0001'), \
                        patch.object(contract, 'run_command', return_value=json.dumps(value).encode()):
                    if case['valid'] and 'error' not in case:
                        self.assertEqual(client.call(method, params), value['result'])
                    else:
                        expected = case.get('error', 'invalid_provider_response')
                        with self.assertRaisesRegex(contract.ProviderError, '^' + expected + '$'):
                            client.call(method, params)

    def test_bundled_provider_consumes_request_fixtures_before_execution(self):
        results = {'describe': read('provider-describe-v1.json')['result'],
                   'relay.ensure': read('provider-relay-v1.json')['result']}
        for case in read('provider-cases.json'):
            if case['boundary'] != 'request':
                continue
            with self.subTest(case=case['name']):
                value = payload(case, 'provider-request-v1.json')
                provider = Mock()
                provider.call.side_effect = lambda method, params: results[method]
                factory = Mock(return_value=provider)
                output = io.StringIO()
                with patch.object(common.sys, 'stdin', SimpleNamespace(buffer=io.BytesIO(json.dumps(value).encode()))), \
                        patch.object(common.sys, 'stdout', output), patch.object(common, 'private_json', return_value={}) as private:
                    common.main(factory)
                response = json.loads(output.getvalue())
                self.assertEqual(response['protocol_version'], 1)
                if case['valid']:
                    self.assertEqual(response['id'], value['id'])
                    self.assertEqual(response['result'], results[value['method']])
                    factory.assert_called_once_with({})
                else:
                    self.assertEqual(response['error'], {'code': case.get('error', 'invalid_request'), 'retryable': False})
                    factory.assert_not_called()
                    private.assert_not_called()

    def test_published_schema_fields_versions_and_limits_match_runtime_boundaries(self):
        # Extend the existing enum-parity approach, not a partial schema engine or
        # a mandatory third-party runtime dependency. Runtime also checks URL/port
        # agreement and private files, as the published schema explicitly states.
        definitions = json.loads((ROOT.parents[1] / 'docs/remote-provider-v1.schema.json').read_text())['$defs']
        self.assertEqual(definitions['request']['properties']['method']['enum'], list(contract.REQUIRED + contract.CAPABILITIES))
        for direction in ('request', 'response'):
            self.assertEqual(definitions[direction]['properties']['protocol_version'], {'const': contract.VERSION, 'type': 'integer'})
            self.assertFalse(definitions[direction]['additionalProperties'])
        self.assertEqual(set(definitions['request']['required']), set(read('provider-request-v1.json')))
        self.assertEqual(set(definitions['describe']['required']), set(read('provider-describe-v1.json')['result']))
        self.assertEqual(definitions['describe']['properties']['label']['maxLength'], 80)
        self.assertEqual(definitions['describe']['properties']['capabilities']['maxItems'], len(contract.CAPABILITIES))
        self.assertTrue(definitions['describe']['properties']['capabilities']['uniqueItems'])
        self.assertEqual(definitions['argv']['maxItems'], 128)
        port = definitions['connection']['properties']['tunnel']['oneOf'][1]['properties']['port']
        self.assertEqual((port['minimum'], port['maximum']), (1, 65535))
        for count in (80, 81):
            value = {'id': 'example', 'label': '🌍' * count, 'capabilities': []}
            if count == 80:
                contract.validate_result('describe', value)
            else:
                with self.assertRaises(contract.ProviderError):
                    contract.validate_result('describe', value)


if __name__ == '__main__':
    unittest.main()
