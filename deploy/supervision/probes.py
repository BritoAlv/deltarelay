"""Authenticated relay and independent internet probes."""

import json
from pathlib import Path
import re
import ssl
import time
import urllib.error
import urllib.request

from recover_relay import private_text
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
        except (OSError, ValueError, ControlError):
            raise ControlError('identity_unavailable') from None
        if not isinstance(expected, str) or not re.fullmatch(r'[0-9a-f]{64}', expected):
            raise ControlError('identity_unavailable')
        return expected

    def relay(self):
        started = time.monotonic()
        try:
            token = private_text(Path(self.config['relay_token_file']))
            expected = private_json(Path(self.config['relay_state_file']), 4096)
            if not isinstance(expected, str) or not re.fullmatch(r'[0-9a-f]{64}', expected):
                return 'identity_unavailable'
            request = urllib.request.Request(self.config['relay_url'].rstrip('/') + '/v2/info',
                                             headers={'Authorization': 'Bearer ' + token})
            self.log('event', f'HTTP GET {request.full_url} timeout=2s; authenticated headers omitted')
            with self.opener.open(request, timeout=2) as response:
                info = json.loads(response.read(65537))
                self.log('event', f'HTTP status={getattr(response, "status", 200)} elapsed={time.monotonic() - started:.3f}s; checking protocol, pinned identity, and forwarding')
            if not isinstance(info, dict) or info.get('version') != 2:
                return 'protocol_mismatch'
            if info.get('state_id') != expected:
                return 'identity_mismatch'
            return 'connected' if info.get('forwarding') else 'forwarding_disabled'
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
        except (OSError, ValueError, ControlError) as error:
            self.log('error', f'Relay probe: {type(error).__name__}: {error}')
            return 'configuration_error'

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
