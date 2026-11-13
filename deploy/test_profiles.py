import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from remote_provider import ProviderError
import supervision.profiles as profiles


class ProfileLayoutTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.project = Path(self.temporary.name)
        self.root = profiles.profiles_root(self.project)
        self.root.mkdir(parents=True, mode=0o700)
        os.chmod(self.root, 0o700)

    def profile(self, name, mode=0o700, token='a' * 64):
        path = self.root / name
        path.mkdir(mode=mode)
        os.chmod(path, mode)
        state = path / 'state'
        state.mkdir(mode=0o700)
        (path / 'provider.json').write_text(json.dumps({'name': 'example-codespace'}))
        (path / 'relay.token').write_text(token + '\n')
        (state / 'relay-state.json').write_text(json.dumps('b' * 64))
        for item in (path / 'provider.json', path / 'relay.token', state / 'relay-state.json'):
            os.chmod(item, 0o600)
        return path

    def test_resolve_and_list_only_complete_private_profiles(self):
        self.profile('alpha')
        self.profile('beta')
        self.profile('broken', token='')
        self.assertEqual(profiles.list_profiles(self.project), ['alpha', 'beta'])
        resolved = profiles.resolve_profile(self.project, 'alpha')
        self.assertEqual(resolved['name'], 'alpha')
        self.assertEqual(resolved['state_id'], 'b' * 64)
        self.assertEqual(resolved['provider']['name'], 'example-codespace')

    def test_names_reject_paths_and_traversal(self):
        for name in ('', '.', '..', 'a/b', '../alpha', 'alpha\n', 'a' * 65):
            with self.subTest(name=name), self.assertRaisesRegex(ProviderError, '^invalid_profile_name$'):
                profiles.resolve_profile(self.project, name)

    def test_unsafe_or_incomplete_profile_is_rejected(self):
        self.profile('alpha', mode=0o755)
        with self.assertRaisesRegex(ProviderError, '^unsafe_profile_directory$'):
            profiles.resolve_profile(self.project, 'alpha')

    def test_current_pointer_is_relative_and_atomically_replaced(self):
        self.profile('alpha')
        self.profile('beta')
        profiles.point_current(self.project, 'alpha')
        self.assertEqual(profiles.active_profile(self.project), 'alpha')
        self.assertEqual(os.readlink(profiles.current_link(self.project)), 'codespaces/alpha')
        profiles.point_current(self.project, 'beta')
        self.assertEqual(profiles.active_profile(self.project), 'beta')
        self.assertEqual(os.readlink(profiles.current_link(self.project)), 'codespaces/beta')

    def config(self, name='alpha'):
        current = profiles.current_link(self.project)
        local = self.project / 'local'
        local.mkdir(mode=0o700, exist_ok=True)
        value = {
            'version': 1,
            'profile': str(local),
            'relay_url': 'http://127.0.0.1:18787',
            'gateway_url': 'http://127.0.0.1:18788',
            'relay_token_file': str(current / 'relay.token'),
            'local_token_file': str(local / 'local.token'),
            'relay_state_file': str(current / 'state/relay-state.json'),
            'remote': {'command': ['/bin/true'], 'config_file': str(current / 'provider.json')},
            'components': {},
        }
        path = self.project / 'supervisor.json'
        path.write_text(json.dumps(value))
        os.chmod(path, 0o600)
        return path

    def test_switch_stops_points_and_restarts_in_order(self):
        self.profile('alpha')
        config = self.config()
        events = []
        with patch.object(profiles, 'stop_local', side_effect=lambda *args: events.append('stop')), \
                patch.object(profiles, 'point_current', side_effect=lambda *args: events.append('point')), \
                patch.object(profiles, 'start_local', side_effect=lambda *args: events.append('start')):
            result = profiles.switch_codespace(self.project, 'alpha', config, report=lambda _: None)
        self.assertEqual(events, ['stop', 'point', 'start'])
        self.assertEqual(result['name'], 'alpha')

    def test_pointer_only_switch_does_not_touch_services(self):
        self.profile('alpha')
        config = self.config()
        with patch.object(profiles, 'stop_local') as stop, \
                patch.object(profiles, 'point_current') as point, \
                patch.object(profiles, 'start_local') as start:
            profiles.switch_codespace(self.project, 'alpha', config, restart=False, report=lambda _: None)
        stop.assert_not_called()
        point.assert_called_once()
        start.assert_not_called()

    def test_switch_requires_paths_through_the_current_pointer(self):
        self.profile('alpha')
        config = self.config()
        value = json.loads(config.read_text())
        value['relay_token_file'] = str(self.project / 'elsewhere.token')
        config.write_text(json.dumps(value))
        with patch.object(profiles, 'stop_local') as stop, patch.object(profiles, 'point_current') as point:
            with self.assertRaisesRegex(ProviderError, '^profiles_not_configured$'):
                profiles.switch_codespace(self.project, 'alpha', config, report=lambda _: None)
        stop.assert_not_called()
        point.assert_not_called()
