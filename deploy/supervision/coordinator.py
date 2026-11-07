"""Single mutation lane, independently observable component recovery runs.

The planner chooses one action from current facts, then observations are
refreshed. Adapters cannot restart peers. Checkpoints are diagnostic state, not
a queue of commands to replay after a crash.
"""

import re

from activity import operation_id
from remote_provider import RETRYABLE, ProviderError as ControlError, private_json

from .components import registry
from .contracts import ConnectionFacts, Step, next_connection_step
from .state import save_json, stamp
from .topology import shutdown_blockers


class Coordinator:
    def __init__(self, supervisor):
        self.supervisor = supervisor
        self.adapters = registry(supervisor)
        self.path = supervisor.directory / 'recovery-run.json'
        self.current = None
        self.owns = False
        self.load_checkpoint()

    def load_checkpoint(self):
        if not self.path.exists():
            return
        value = private_json(self.path)
        required = {'version', 'id', 'request_id', 'target', 'action', 'trigger', 'status',
                    'current_component', 'current_action', 'started_at', 'finished_at', 'error', 'steps'}
        if (not isinstance(value, dict) or set(value) != required or value.get('version') != 1 or
                not isinstance(value.get('id'), str) or not re.fullmatch('[a-f0-9]{16}', value['id']) or
                not isinstance(value.get('request_id'), str) or not re.fullmatch('(?:[a-f0-9]{32})?', value['request_id']) or
                value.get('status') not in ('running', 'completed', 'failed', 'interrupted') or
                value.get('trigger') not in ('manual', 'automatic', 'startup') or
                not all(isinstance(value.get(key), str) for key in ('target', 'action', 'current_component', 'current_action', 'started_at', 'error')) or
                value['target'] not in ('dashboard', 'gateway', 'tunnel', 'relay', 'opencode', 'desktop', 'remote', 'remote_provider', 'all', 'connection') or
                value['action'] not in ('start', 'restart', 'recover', 'stop', 'wake', 'observe', 'verify') or
                value['current_component'] not in ('', 'dashboard', 'gateway', 'tunnel', 'relay', 'opencode', 'desktop', 'remote', 'remote_provider') or
                value['current_action'] not in ('', 'start', 'restart', 'recover', 'stop', 'wake', 'observe', 'verify') or
                not re.fullmatch('[a-z_]{0,64}', value['error']) or
                not (value['finished_at'] is None or isinstance(value['finished_at'], str)) or
                not isinstance(value.get('steps'), list) or len(value['steps']) > 64 or
                any(not isinstance(step, dict) or
                    set(step) != {'component', 'action', 'status', 'started_at', 'finished_at', 'error'} or
                    step.get('component') not in ('dashboard', 'gateway', 'tunnel', 'relay', 'opencode', 'desktop', 'remote', 'remote_provider') or
                    step.get('action') not in ('start', 'restart', 'recover', 'stop', 'wake', 'observe', 'verify') or
                    step.get('status') not in ('running', 'completed', 'failed', 'interrupted') or
                    not all(isinstance(step.get(key), str) for key in ('component', 'action', 'started_at', 'error')) or
                    not re.fullmatch('[a-z_]{0,64}', step['error']) or
                    not (step.get('finished_at') is None or isinstance(step.get('finished_at'), str))
                    for step in value.get('steps', []))):
            raise ControlError('configuration_error')
        # Never automatically replay a mutation whose outcome is uncertain.
        if value['status'] == 'running':
            value.update(status='interrupted', current_component='', current_action='',
                         finished_at=stamp(), error='operation_interrupted')
            for step in value['steps']:
                if step['status'] == 'running':
                    step.update(status='interrupted', finished_at=stamp(), error='operation_interrupted')
            save_json(self.path, value)
        self.supervisor.state.set_run(value)

    def publish(self):
        # Persist before publishing/performing the next mutation. A failed private
        # checkpoint write fails closed instead of hiding an untracked operation.
        save_json(self.path, self.current)
        self.supervisor.state.set_run(self.current)

    def begin(self, target, action, trigger='manual', identifier=None, request_id=''):
        if self.current is not None:
            raise ControlError('operation_in_progress')
        self.owns = True
        self.current = {'version': 1, 'id': identifier or operation_id(), 'request_id': request_id,
                        'target': target, 'action': action, 'trigger': trigger, 'status': 'running',
                        'current_component': '', 'current_action': '', 'started_at': stamp(),
                        'finished_at': None, 'error': '', 'steps': []}
        self.publish()
        return self.current['id']

    def finish(self, error=''):
        if not self.current or not self.owns:
            return
        self.current.update(status='failed' if error else 'completed', error=error,
                            finished_at=stamp(), current_component='', current_action='')
        self.publish()
        self.current = None
        self.owns = False

    def execute(self, step, callback=None):
        s = self.supervisor
        if s.stop.is_set():
            raise ControlError('operation_cancelled')
        blocked = s.policy.provider_blocked_value()
        if (blocked and step.component in ('tunnel', 'relay', 'remote', 'remote_provider') and
                step.action not in ('observe', 'verify', 'stop')):
            raise ControlError(blocked)
        owns_run = self.current is None
        if owns_run:
            self.begin(step.component, step.action)
        record = {'component': step.component, 'action': step.action, 'status': 'running',
                  'started_at': stamp(), 'finished_at': None, 'error': ''}
        # Small bounded snapshots survive browser refresh and keep fast steps visible.
        self.current['steps'] = self.current['steps'][-63:] + [record]
        self.current.update(current_component=step.component, current_action=step.action)
        self.publish()
        error = ''
        try:
            method = callback or getattr(self.adapters[step.component], step.action)
            with s.journal.context(component=step.component, operation=self.current['id']):
                result = method()
            record.update(status='completed', finished_at=stamp())
            return result
        except Exception as cause:
            error = str(cause) if isinstance(cause, ControlError) else 'operation_failed'
            record.update(status='failed', error=error, finished_at=stamp())
            raise
        finally:
            self.publish()
            if owns_run:
                self.finish(error)

    def connection(self, wake=False):
        s = self.supervisor
        owns_run = self.current is None
        if owns_run:
            self.begin('connection', 'recover', 'automatic' if s.state.recovery_value('busy') else 'manual')
            s.state.begin_operation('recovering_connection')
        error = ''
        recovery_error = None
        facts = ConnectionFacts(wake=wake)
        try:
            blocked = s.policy.provider_blocked_value()
            if blocked:
                raise ControlError(blocked)
            s.state.update_recovery(phase='recovering_connection')
            # The pure policy has a finite action budget. No hidden nested repair
            # loops; readiness waits belong to the adapter being verified.
            for _ in range(16):
                step = next_connection_step(facts)
                if step is None:
                    if facts.relay != 'connected':
                        raise recovery_error or ControlError('unreachable')
                    if 'gateway' in s.config['components'] and s.state.wanted('gateway'):
                        self.local('gateway', 'recover')
                    s.state.update_recovery(phase='monitoring')
                    return
                if step.action == 'blocked':
                    raise ControlError('host_stopped')
                if step.component == 'relay' and step.action == 'observe':
                    facts.relay = self.execute(step)
                    if facts.relay not in ('connected', 'unreachable'):
                        raise ControlError(facts.relay)
                    if facts.relay == 'unreachable' and s.state.snapshot()['internet_state'] == 'unreachable':
                        raise ControlError('no_internet')
                elif step.component == 'remote_provider':
                    self.execute(step)
                    facts.provider_ready = True
                    facts.can_wake = s.supports('host.wake')
                    facts.has_tunnel = 'tunnel' in s.config['components']
                elif step.component == 'remote':
                    if step.action == 'wake':
                        self.execute(step, self.adapters['remote'].start)
                        facts.host = s.state.host_value()
                    elif step.action == 'verify':
                        self.execute(step)
                        facts.host = s.state.host_value()
                    else:
                        facts.host = self.execute(step)
                        facts.host_checked = True
                elif step.component == 'tunnel':
                    s.state.update_recovery(phase='connecting_tunnel')
                    self.execute(step)
                    facts.tunnel_repairs += 1
                    facts.verification_due = True
                elif step.action == 'recover':
                    # A timeout may follow successful remote startup. Do not
                    # blindly repeat it; verify the actual connection next.
                    try:
                        self.execute(step)
                    except ControlError as cause:
                        if str(cause) not in RETRYABLE:
                            raise
                        recovery_error = cause
                    facts.relay_attempted = True
                    facts.verification_due = not facts.has_tunnel
                elif step.action == 'verify':
                    connected = self.execute(step)
                    facts.relay = 'connected' if connected else 'unreachable'
                    facts.verification_due = False
            raise ControlError('unreachable')
        except Exception as cause:
            error = str(cause) if isinstance(cause, ControlError) else 'operation_failed'
            s.state.update_recovery(last_error=error)
            raise
        finally:
            if owns_run:
                self.finish(error)
                s.state.finish_operation()

    def local(self, name, action):
        s = self.supervisor
        owns_run = self.current is None
        if owns_run:
            self.begin(name, action, 'automatic')
            s.state.begin_operation(action + '_' + name)
        failure = ''
        try:
            result = self.execute(Step(name, action))
            # Separate evidence from command completion. API-bearing services
            # get a cold-start window; a Desktop has no independent readiness API.
            observation = self.execute(Step(name, 'verify'))
            if observation.readiness == 'not_ready' and name in ('gateway', 'opencode') and action != 'stop':
                deadline = s.clock() + 15
                for _ in range(15):
                    if s.stop.wait(1):
                        raise ControlError('operation_cancelled')
                    observation = self.execute(Step(name, 'verify'))
                    if observation.readiness != 'not_ready' or s.clock() >= deadline:
                        break
                if observation.readiness == 'not_ready':
                    raise ControlError('component_not_ready')
            return result
        except Exception as cause:
            failure = str(cause) if isinstance(cause, ControlError) else 'operation_failed'
            raise
        finally:
            if owns_run:
                self.finish(failure)
                s.state.finish_operation()

    def start_system(self):
        s = self.supervisor
        intent = s.state.intent_copy()
        intent.update(system='running', remote='running')
        # Preserve per-component choices such as --no-desktop. Global shutdown is
        # the resumable pause, not a destructive rewrite of those preferences.
        if 'gateway' in s.config['components']:
            intent['components']['gateway'] = True
        s.persist_intent(intent)
        s.update_settings({'auto_reconnect': True, 'auto_wake': s.state.settings_copy()['auto_wake']})
        local_error = self.start_locals()
        # Capabilities may not have been discovered yet after a supervisor
        # restart. Start system is an explicit wake consent, so discover the
        # provider contract before deciding whether wake is available.
        if s.provider is not None and s.provider.connection is None:
            try:
                self.execute(Step('remote_provider', 'observe'))
            except ControlError:
                pass
        self.connection(wake=s.supports('host.wake'))
        if local_error:
            raise local_error

    def start_locals(self):
        s = self.supervisor
        error = None
        for name in ('dashboard', 'gateway', 'opencode', 'desktop'):
            spec = s.config['components'].get(name, {})
            if s.state.wanted(name) and (spec.get('command') or spec.get('start_command')):
                try:
                    self.execute(Step(name, 'start'))
                except ControlError as cause:
                    s.state.set_component(name, str(cause))
                    error = cause
        return error

    def stop_system(self):
        s = self.supervisor
        blockers = shutdown_blockers(s.state)
        if blockers:
            raise ControlError('shutdown_not_configured')
        # Persist suppression before ANY service-changing operation. It remains
        # in force after partial shutdown, timeouts and supervisor restarts.
        intent = s.state.intent_copy()
        intent.update(system='stopped', remote='stopped')
        s.persist_intent(intent)
        s.update_settings({'auto_reconnect': False, 'auto_wake': False})
        error = None
        for name in ('desktop', 'opencode', 'gateway', 'tunnel'):
            spec = s.config['components'].get(name, {})
            if spec.get('command') or spec.get('stop_command'):
                try:
                    self.execute(Step(name, 'stop'))
                    observed = self.execute(Step(name, 'verify'))
                    # Owned child processes are independently verifiable by PID.
                    # Service-manager stop commands may not expose status; an
                    # unknown observation is reported, not invented as stopped.
                    if spec.get('command') and observed.lifecycle != 'stopped':
                        error = ControlError('component_stop_unverified')
                except ControlError as cause:
                    error = cause
        can_stop = s.supports('host.stop')
        if s.provider is not None and not can_stop and s.provider.connection is None:
            try:
                self.execute(Step('remote_provider', 'observe'))
                can_stop = s.supports('host.stop')
            except ControlError as cause:
                # Local shutdown still proceeds; do not claim the VPS stopped
                # when provider discovery failed.
                error = error or cause
        if can_stop:
            try:
                self.execute(Step('remote', 'stop'))
            except ControlError as cause:
                error = error or cause
        # Unsupported cloud stop is not falsely reported as powered off. Local
        # shutdown still works; the map states that power management is absent.
        if error:
            raise error

    def stop_remote(self):
        s = self.supervisor
        intent = s.state.intent_copy()
        intent['remote'] = 'stopped'
        s.persist_intent(intent)
        s.update_settings({'auto_reconnect': False, 'auto_wake': False})
        error = None
        if 'command' in s.config['components'].get('tunnel', {}):
            try:
                self.execute(Step('tunnel', 'stop'))
            except ControlError as cause:
                error = cause
            else:
                observed = self.execute(Step('tunnel', 'verify'))
                if observed.lifecycle != 'stopped':
                    error = ControlError('component_stop_unverified')
        try:
            self.execute(Step('remote', 'stop'))
        except ControlError as cause:
            error = error or cause
        if error:
            raise error

    def manual(self, name, action):
        s = self.supervisor
        if name == 'all' and action == 'stop':
            return self.stop_system()
        if name == 'all' and action == 'start':
            return self.start_system()
        if name == 'all' and action == 'recover':
            local_error = self.start_locals()
            self.connection(wake=s.state.settings_copy()['auto_wake'])
            if local_error:
                raise local_error
            return
        if name == 'remote':
            if action == 'stop':
                return self.stop_remote()
            intent = s.state.intent_copy()
            intent['remote'] = 'running'
            s.persist_intent(intent)
            return self.connection(wake=True)
        if name == 'relay':
            self.execute(Step('relay', action))
            if 'tunnel' in s.config['components']:
                self.execute(Step('tunnel', 'recover'))
            if not self.execute(Step('relay', 'verify')):
                raise ControlError('unreachable')
            return
        if name == 'all' and action == 'restart':
            # Legacy confirmed API operation; not exposed as a normal UI action.
            self.execute(Step('relay', 'restart'))
            for component in ('tunnel', 'gateway', 'opencode', 'desktop', 'dashboard'):
                spec = s.config['components'].get(component, {})
                if spec.get('command') or spec.get('restart_command'):
                    self.execute(Step(component, 'restart'))
            if not self.execute(Step('relay', 'verify')):
                raise ControlError('unreachable')
            return
        if name == 'tunnel' and action == 'recover':
            return self.connection(wake=s.state.settings_copy()['auto_wake'])
        intent = s.state.intent_copy()
        # Starting one node is NOT permission to restart the whole stopped stack.
        # Stopping one node is an explicit intent that automatic recovery honors.
        intent['components'][name] = action != 'stop'
        s.persist_intent(intent)
        return self.local(name, action)
