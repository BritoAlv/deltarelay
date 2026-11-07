"""Authenticated relay and independent internet probes."""

import base64
import http.client
import json
from pathlib import Path
import re
import ssl
import time
import urllib.error
import urllib.request
import urllib.parse

from recover_relay import RecoveryError, private_text
from remote_provider import ProviderError as ControlError, private_json

from .config import DEFAULT_INTERNET_CHECK_URL


class RelayProbe:
    def __init__(self, config, opener, trace=None):
        self.config = config
        self.opener = opener
        self.trace = trace

    def log(self, stream, text):
        if self.trace:
            self.trace(stream, text)

    def expected_identity(self):
        try:
            expected = private_json(Path(self.config['relay_state_file']), 4096)
        except (OSError, ValueError, ControlError, RecoveryError):
            raise ControlError('identity_unavailable') from None
        if not isinstance(expected, str) or not re.fullmatch(r'[0-9a-f]{64}', expected):
            raise ControlError('identity_unavailable')
        return expected

    def read_json(self, url, headers=None):
        request = urllib.request.Request(url, headers=headers or {})
        with self.opener.open(request, timeout=2) as response:
            data = response.read(262145)
            if len(data) > 262144:
                raise ValueError('oversized health response')
            return json.loads(data)

    def gateway(self):
        try:
            token = private_text(Path(self.config['local_token_file']))
            result = self.read_json(self.config['gateway_url'].rstrip('/') + '/livez',
                                    {'X-DeltaRelay-Local-Token': token})
            return 'ready' if result.get('alive') is True and result.get('version') == 2 else 'unknown'
        except urllib.error.HTTPError as error:
            # An old binary has no local-only probe. A credential mismatch is a
            # configuration fault, not proof that a restart would help.
            result = 'unknown' if error.code in (401, 403, 404) else 'not_ready'
            error.close()
            return result
        except (OSError, ValueError, ControlError, RecoveryError, http.client.HTTPException):
            return 'not_ready'

    def opencode_registration(self):
        registration = private_json(Path(self.config['opencode_service_file']))
        url = registration.get('url', '')
        parsed = urllib.parse.urlsplit(url)
        if (parsed.scheme != 'http' or parsed.hostname not in ('127.0.0.1', 'localhost', '::1') or
                parsed.username or parsed.password or parsed.path not in ('', '/') or
                parsed.query or parsed.fragment or not isinstance(registration.get('password'), str) or
                not registration['password']):
            raise ValueError('unsafe service registration')
        auth = base64.b64encode(('opencode:' + registration['password']).encode()).decode()
        return registration, url.rstrip('/'), {'Authorization': 'Basic ' + auth}

    def opencode(self):
        if not self.config.get('opencode_service_file'):
            return 'unknown'
        try:
            registration, url, headers = self.opencode_registration()
            result = self.read_json(url + '/api/info', headers)
            if not isinstance(result, dict) or not isinstance(result.get('version'), str):
                return 'unknown'
            if registration.get('pid') and result.get('pid') != registration['pid']:
                return 'unknown'
            return 'ready'
        except (OSError, ValueError, ControlError, RecoveryError, http.client.HTTPException):
            return 'not_ready'

    def plugin(self):
        # Plugin state is location-specific. Never guess which project to inspect.
        directory = self.config.get('opencode_directory')
        if not directory or not self.config.get('opencode_service_file'):
            return 'unknown'
        try:
            _, url, headers = self.opencode_registration()
            query = urllib.parse.urlencode({'location[directory]': directory})
            result = self.read_json(url + '/api/plugin?' + query, headers)
            plugins = result.get('data', [])
            for plugin in plugins:
                if plugin.get('id') == 'deltarelay':
                    return 'ready' if plugin.get('state', {}).get('status') == 'active' else 'not_ready'
            return 'not_ready'
        except (OSError, ValueError, ControlError, RecoveryError, http.client.HTTPException, AttributeError, TypeError):
            return 'unknown'

    def relay(self):
        # Configuration errors are permanent; transport errors are not. Read the
        # private files first so a dropped tunnel can never be mistaken for an
        # invalid token or identity pin and block automatic recovery.
        try:
            token = private_text(Path(self.config['relay_token_file']))
            expected = private_json(Path(self.config['relay_state_file']), 4096)
        except (OSError, ValueError, ControlError, RecoveryError) as error:
            self.log('error', f'Relay probe configuration: {type(error).__name__}: {error}')
            return 'configuration_error'
        if not isinstance(expected, str) or not re.fullmatch(r'[0-9a-f]{64}', expected):
            return 'identity_unavailable'

        started = time.monotonic()
        try:
            request = urllib.request.Request(self.config['relay_url'].rstrip('/') + '/info',
                                             headers={'Authorization': 'Bearer ' + token})
            self.log('event', f'HTTP GET {request.full_url} timeout=2s; authenticated headers omitted')
            with self.opener.open(request, timeout=2) as response:
                body = response.read(65537)
                status = getattr(response, 'status', 200)
            self.log('event', f'HTTP status={status} elapsed={time.monotonic() - started:.3f}s; checking protocol, pinned identity, and forwarding')
        except urllib.error.HTTPError as error:
            self.log('error', f'HTTP GET relay: {type(error).__name__}: {error}; elapsed={time.monotonic() - started:.3f}s')
            code = error.code
            error.close()
            return 'authentication_failed' if code in (401, 403) else 'unreachable' if code in (408, 429, 502, 503, 504) else 'protocol_mismatch'
        except urllib.error.URLError as error:
            self.log('error', f'HTTP GET relay: {type(error.reason).__name__}: {error.reason}; elapsed={time.monotonic() - started:.3f}s')
            if isinstance(error.reason, ssl.SSLCertVerificationError):
                return 'tls_verification_failed'
            return 'unreachable'
        except TimeoutError as error:
            self.log('error', f'HTTP GET relay: {type(error).__name__}: {error}; elapsed={time.monotonic() - started:.3f}s')
            return 'unreachable'
        except ssl.SSLCertVerificationError as error:
            self.log('error', f'HTTP GET relay: {type(error).__name__}: {error}; elapsed={time.monotonic() - started:.3f}s')
            return 'tls_verification_failed'
        except (OSError, http.client.HTTPException) as error:
            # Reset, aborted, refused, and truncated streams are transient local
            # link failures. Retry them instead of requiring a supervisor restart.
            self.log('error', f'HTTP GET relay: {type(error).__name__}: {error}; elapsed={time.monotonic() - started:.3f}s')
            return 'unreachable'
        try:
            info = json.loads(body)
        except (ValueError, UnicodeError) as error:
            # A reset during the body read can leave valid HTTP framing but
            # invalid JSON. It is still a transient response, not bad local config.
            self.log('error', f'Relay probe response: {type(error).__name__}: {error}; invalid or truncated JSON')
            return 'unreachable'
        if not isinstance(info, dict) or info.get('version') != 2:
            return 'protocol_mismatch'
        if info.get('state_id') != expected:
            return 'identity_mismatch'
        return 'connected' if info.get('forwarding') else 'forwarding_disabled'

    def internet(self):
        """Check generic internet reachability without touching relay credentials.

        This runs only while the relay probe is unreachable, so a healthy local
        tunnel does not generate extra external traffic.
        """
        url = self.config.get('internet_check_url', DEFAULT_INTERNET_CHECK_URL)
        request = urllib.request.Request(url, method='HEAD')
        started = time.monotonic()
        self.log('event', f'HTTP HEAD {url} timeout=2s; no relay/provider credentials')
        try:
            with self.opener.open(request, timeout=2) as response:
                response.read(1)
                self.log('event', f'HTTP status={getattr(response, "status", 200)} elapsed={time.monotonic() - started:.3f}s')
            return 'connected'
        except urllib.error.HTTPError as error:
            self.log('event', f'HTTP HEAD internet: status={error.code}; HTTP response confirms network path')
            # Any HTTP response proves that an internet path exists.
            error.close()
            return 'connected'
        except urllib.error.URLError as error:
            self.log('error', f'HTTP HEAD internet: {type(error.reason).__name__}: {error.reason}')
            # A certificate/interception failure is not "no internet"; it is a
            # separate TLS problem. DNS, routing, and connection failures are.
            return 'connected' if isinstance(error.reason, ssl.SSLCertVerificationError) else 'unreachable'
        except ssl.SSLError as error:
            self.log('error', f'HTTP HEAD internet: {type(error).__name__}: {error}; TLS response confirms network path')
            return 'connected'
        except (TimeoutError, OSError) as error:
            self.log('error', f'HTTP HEAD internet: {type(error).__name__}: {error}')
            return 'unreachable'
