"""Process identity, adoption, launch, stop, and restart."""

import os
from pathlib import Path
import signal
import shlex
import socket
import subprocess
import tempfile
import time

from remote_provider import ProviderError as ControlError, environment, plugin_environment


def process(pid):
    try:
        root = Path('/proc') / str(int(pid))
        if int(pid) <= 1 or root.stat().st_uid != os.getuid():
            return None
        fields = (root / 'stat').read_text().rsplit(')', 1)[1].split()
        if fields[0] == 'Z':
            return None
        args = os.fsdecode((root / 'cmdline').read_bytes()).split('\0')
        return {'pid': int(pid), 'birth': fields[19], 'args': args}
    except (OSError, ValueError, IndexError):
        return None


def matches(info, expected):
    # Electron can rewrite argv's NUL separators into spaces. Require complete
    # argument boundaries, not a broad substring or a system-wide pkill pattern.
    command = ' ' + ' '.join(info['args']).strip() + ' '
    return bool(expected) and all(part in info['args'] or ' ' + part + ' ' in command for part in expected)


class ProcessManager:
    """Owns child processes and on-disk PID identities.

    Component operations are serialized by the supervisor's operation lock, so
    this object intentionally has no second process lock. It only publishes
    component state through :class:`SupervisorState`.
    """

    def __init__(self, config, root, directory, state, stop, clock=None, popen=None, journal=None):
        self.config = config
        self.root = root
        self.directory = directory
        self.state = state
        self.cancel = stop
        self.clock = clock or (lambda: time.monotonic())
        self.popen = popen or subprocess.Popen
        self.children = {}
        self.identities = {}
        self.journal = journal

    def log(self, name, stream, text):
        if self.journal:
            self.journal.write(stream, text, component=name)

    def identity(self, name):
        spec = self.config['components'][name]
        child = self.children.get(name)
        if child is not None:
            previous = child.returncode
            child.poll()  # Reap exited children; never rely on kill(pid, 0).
            if previous is None and child.returncode is not None:
                status = f'exit_code={child.returncode}' if child.returncode >= 0 else f'signal={-child.returncode}'
                self.log(name, 'exit', f'pid={child.pid} {status}')
        info = None
        try:
            info = process(int(Path(spec['pid_file']).read_text().strip()))
        except (OSError, ValueError):
            pass
        expected = spec.get('match', spec['command'])
        if info and matches(info, expected):
            # Status/adoption may follow a service manager's own restart. The
            # destructive path rechecks PID birth immediately before signaling.
            identity = (info['pid'], info['birth'])
            if self.identities.get(name) != identity:
                self.log(name, 'event', f'Adopted verified pid={info["pid"]} birth={info["birth"]}; argv={shlex.join(info["args"])}')
            self.identities[name] = identity
            return info
        # Desktop may hand off to an already-running Electron instance.
        if name == 'desktop' and spec.get('match'):
            for directory in Path('/proc').glob('[0-9]*'):
                candidate = process(directory.name)
                if candidate and matches(candidate, expected) and not any(arg.startswith('--type=') for arg in candidate['args']):
                    self.identities[name] = (candidate['pid'], candidate['birth'])
                    return candidate
        self.identities.pop(name, None)
        return None

    def start(self, name):
        if self.cancel.is_set():
            raise ControlError('operation_cancelled')
        spec = self.config['components'].get(name)
        if not spec or 'command' not in spec:
            raise ControlError('component_unmanaged')
        if self.identity(name):
            self.log(name, 'event', 'Start skipped: verified service process already running')
            self.state.set_component(name, 'running')
            return
        port = spec.get('port')
        if port:
            try:
                with socket.create_connection(('127.0.0.1', port), timeout=0.3):
                    raise ControlError('unrecognized_port_owner')
            except OSError:
                pass
        if name == 'desktop' and not (os.environ.get('DISPLAY') or os.environ.get('WAYLAND_DISPLAY')):
            raise ControlError('graphical_session_required')
        log = self.directory / (name + '.log')
        if self.journal:
            self.journal.follow(name, log)
        fd = os.open(log, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'ab') as output:
            if os.fstat(output.fileno()).st_mode & 0o077:
                raise ControlError('unsafe_log_file')
            env = (plugin_environment(self.config['remote'])
                   if name == 'tunnel' else environment(spec.get('env')))
            self.log(name, 'command', f'$ {shlex.join(spec["command"])}\ncwd={spec.get("directory", self.root)}; stdout/stderr -> {log}')
            child = self.popen(spec['command'], stdin=subprocess.DEVNULL, stdout=output, stderr=output,
                               start_new_session=True, cwd=spec.get('directory', self.root), env=env)
        self.children[name] = child
        self.log(name, 'event', f'Spawned pid={child.pid}; process creation is not a readiness check')
        info = process(child.pid)
        if info:
            self.identities[name] = (child.pid, info['birth'])
        pid_file = Path(spec['pid_file'])
        with tempfile.NamedTemporaryFile(mode='w', dir=pid_file.parent, delete=False) as file:
            temporary = Path(file.name)
            try:
                file.write(str(child.pid) + '\n')
                os.replace(temporary, pid_file)
            finally:
                temporary.unlink(missing_ok=True)
        self.state.set_component(name, 'starting')

    def stop(self, name):
        spec = self.config['components'].get(name, {})
        if 'command' not in spec:
            raise ControlError('component_unmanaged')
        info = self.identity(name)
        if info:
            pid, birth = info['pid'], info['birth']
            # A new PID incarnation must never receive this operation's signal.
            current = process(pid)
            if not current or current['birth'] != birth:
                raise ControlError('process_identity_changed')
            self.log(name, 'event', f'Sending SIGTERM to verified process pid={pid} birth={birth}')
            try:
                if os.getpgid(pid) == pid:
                    os.killpg(pid, signal.SIGTERM)
                else:
                    os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            deadline = self.clock() + 8
            while self.clock() < deadline:
                current = process(pid)
                if not current or current['birth'] != birth:
                    break
                self.cancel.wait(0.1)
            else:
                # A confirmed hung incarnation may be force-stopped after the
                # graceful window. Recheck birth so a recycled PID is untouched.
                current = process(pid)
                if current and current['birth'] == birth:
                    self.log(name, 'event', f'Graceful stop timed out after 8s; sending SIGKILL to verified pid={pid}')
                    try:
                        if os.getpgid(pid) == pid:
                            os.killpg(pid, signal.SIGKILL)
                        else:
                            os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    force_deadline = self.clock() + 3
                    while self.clock() < force_deadline:
                        current = process(pid)
                        if not current or current['birth'] != birth:
                            break
                        self.cancel.wait(0.1)
                    else:
                        raise ControlError('process_stop_timeout')
                elif current:
                    raise ControlError('process_identity_changed')
        child = self.children.get(name)
        if child is not None:
            try:
                child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                pass
            status = 'exit_code=unknown' if child.returncode is None else f'exit_code={child.returncode}' if child.returncode >= 0 else f'signal={-child.returncode}'
            self.log(name, 'exit', f'pid={child.pid} {status}')
        elif not info:
            self.log(name, 'event', 'Stop skipped: no verified running process')
        self.identities.pop(name, None)
        self.state.set_component(name, 'stopped')
