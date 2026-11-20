"""Sanitized topology v1, shared by the map and lifecycle coordinator.

The outer supervisor v2 envelope remains compatible. No private command,
endpoint, network address, service password, or configuration path is published.
"""

from . import state as supervisor_state


NODES = (
    ('vscode', 'Varro in VS Code', 'editor', 'local', 'user'),
    ('desktop', 'OpenCode Desktop', 'desktop', 'local', 'opencode'),
    ('openchamber', 'OpenChamber', 'app', 'local', 'supervisor'),
    ('opencode', 'OpenCode server', 'server', 'local', 'supervisor'),
    ('plugin', 'DeltaRelay plugin', 'plugin', 'local', 'opencode'),
    ('gate', 'Frontend health gate', 'gate', 'local', 'supervisor'),
    ('gateway', 'Local gateway', 'gateway', 'local', 'supervisor'),
    ('tunnel', 'Connection transport', 'link', 'network', 'supervisor'),
    ('network', 'Internet / interfaces', 'network', 'network', 'external'),
    ('remote', 'Remote host', 'host', 'remote', 'remote_provider'),
    ('relay', 'DeltaRelay relay', 'relay', 'remote', 'remote_provider'),
    ('storage', 'Cache / saved responses', 'storage', 'remote', 'relay'),
    ('provider', 'Model provider', 'provider', 'external', 'external'),
    ('dashboard_ui', 'Dashboard browser', 'browser', 'control', 'user'),
    ('dashboard', 'Dashboard service', 'dashboard', 'control', 'supervisor'),
    ('supervisor', 'Recovery supervisor', 'supervisor', 'control', 'launcher'),
    ('remote_provider', 'Remote-host adapter', 'adapter', 'control', 'supervisor'),
)
NODE_IDS = frozenset(row[0] for row in NODES)
EDGES = (
    # Traffic points from caller to service, requires from dependent to
    # prerequisite, contains from owner to resource, manages from controller
    # to controlled resource. A contains edge is not an extra forwarding hop.
    ('vscode', 'gate', 'traffic', 'Attach-only local HTTP'),
    ('openchamber', 'gate', 'traffic', 'Attach-only local HTTP'),
    ('gate', 'opencode', 'traffic', 'Authenticated local HTTP'),
    ('gate', 'gateway', 'requires', 'Backend readiness probe'),
    ('desktop', 'opencode', 'traffic', 'Local API'),
    ('opencode', 'plugin', 'contains', 'Provider hooks'),
    ('plugin', 'gateway', 'traffic', 'Authenticated local HTTP'),
    ('gateway', 'tunnel', 'traffic', 'Relay protocol'),
    ('tunnel', 'relay', 'traffic', 'Authenticated relay'),
    ('tunnel', 'network', 'requires', 'Usable route'),
    ('remote', 'relay', 'contains', 'Host must be running'),
    ('relay', 'storage', 'contains', 'Owned request cache / response mailbox (read / write)'),
    ('relay', 'provider', 'traffic', 'Allowlisted HTTPS'),
    ('dashboard_ui', 'dashboard', 'traffic', 'Same-origin controls'),
    ('dashboard', 'gateway', 'traffic', 'Read-only statistics / request inspection'),
    ('dashboard', 'opencode', 'traffic', 'Optional read-only session / auth metadata'),
    ('dashboard', 'supervisor', 'manages', 'Private control socket'),
    ('supervisor', 'gate', 'manages', 'Configured lifecycle'),
    ('supervisor', 'openchamber', 'manages', 'Configured lifecycle'),
    ('supervisor', 'desktop', 'manages', 'Configured lifecycle'),
    ('supervisor', 'opencode', 'manages', 'Configured lifecycle'),
    ('supervisor', 'gateway', 'manages', 'Configured lifecycle'),
    ('supervisor', 'tunnel', 'manages', 'Configured lifecycle'),
    ('supervisor', 'remote_provider', 'manages', 'Provider contract v1'),
    ('remote_provider', 'remote', 'manages', 'Advertised capabilities'),
    ('remote_provider', 'relay', 'manages', 'Existing-store recovery'),
)


def shutdown_blockers(state):
    return [name for name, spec in state._specs.items()
            if name in ('desktop', 'openchamber', 'opencode', 'gateway', 'gate', 'tunnel') and
            (spec.get('command') or spec.get('start_command')) and
            not (spec.get('command') or spec.get('stop_command'))]


def gate_local(state, by_id):
    """Derive gate access readiness from local OpenCode/plugin observations.

    Returns (ready, reason): ready is True/False, or None when an independent
    observation is still unknown. Relay availability is deliberately excluded:
    it gates model requests inside the gateway, not local session access.
    """
    opencode = by_id['opencode']['readiness']
    plugin = by_id['plugin']['readiness']
    if opencode in ('not_ready', 'blocked'):
        return False, 'service_down'
    if opencode != 'ready':
        return None, ''
    if state.opencode_directory:
        if plugin in ('not_ready', 'blocked'):
            return False, 'plugin_unavailable'
        if plugin != 'ready':
            return None, ''
    return True, ''


def gate_backend(state, by_id):
    """Derive complete model-request readiness from existing observations.

    Returns (ready, reason): ready is True/False, or None when an independent
    observation is still unknown. This never probes the gateway or OpenCode.
    """
    gateway = by_id['gateway']['readiness']
    if gateway in ('not_ready', 'blocked') or state.relay_state not in ('connected', 'unknown'):
        return False, 'gateway_down'
    if gateway != 'ready' or state.relay_state != 'connected':
        return None, ''
    return gate_local(state, by_id)


def snapshot(state):
    nodes = []
    capabilities = state.metadata.get('capabilities', ())
    for name, label, kind, group, owner in NODES:
        lifecycle = state.states.get(name, 'unknown')
        observation = state.observations.get(name, {})
        readiness = observation.get('readiness', 'unknown')
        lifecycle = observation.get('lifecycle', lifecycle)
        detail = observation.get('detail', 'No independent readiness evidence yet.')
        checked = observation.get('checked_at')
        managed = state._can_start.get(name, False)
        desired = 'running' if state.wanted(name) else 'stopped'
        actions = []
        # No empty component specs exist; this snapshot alone decides whether a
        # lifecycle action is both configured and currently meaningful. Restart is
        # disruption control, not recovery, and therefore shown only when running.
        if managed and name not in ('dashboard', 'supervisor'):
            actions.append('stop' if lifecycle in ('running', 'started', 'starting') else 'start')
            actions.append('recover')
        if state._can_restart.get(name, False) and lifecycle in ('running', 'started'):
            actions.append('restart')
        if name == 'relay':
            lifecycle = 'running' if state.relay_state == 'connected' else lifecycle
            readiness = 'ready' if state.relay_state == 'connected' else 'blocked' if state.relay_state not in ('unknown', 'unreachable') else 'unknown'
            checked = state.recovery['last_connected_at'] if readiness == 'ready' else checked
            detail = ('Authenticated identity, protocol, and forwarding verified.' if readiness == 'ready'
                      else f'Authenticated relay health reports {state.relay_state}; this does not prove the relay process is down. Recovery will not bypass authentication, TLS, protocol, identity, or forwarding errors.')
            actions = []
            if 'relay.ensure' in capabilities:
                actions.append('recover')
            if 'relay.restart' in capabilities and readiness == 'ready':
                actions.append('restart')
        elif name == 'remote':
            label = state.metadata.get('label', label)
            lifecycle = state.host_state
            readiness = 'ready' if lifecycle == 'running' else 'not_ready' if lifecycle == 'stopped' else 'unknown'
            managed = bool(set(capabilities) & {'host.wake', 'host.stop'})
            actions = [action for action, capability in (('wake', 'host.wake'), ('stop', 'host.stop')) if capability in capabilities and (capability != 'host.wake' or lifecycle != 'running')]
            desired = state.intent['remote'] if state.intent['system'] == 'running' else 'stopped'
            detail = 'Power state is not proof of SSH, tunnel, or relay readiness.'
        elif name == 'network':
            lifecycle = 'unknown'
            readiness = {'connected': 'ready', 'unreachable': 'not_ready'}.get(state.internet_state, 'unknown')
            checked = state.internet_checked_at
            desired = 'external'
            detail = ('The independent Internet check failed. Check Ethernet, Wi-Fi, VPN, or routing; networking is never modified automatically.'
                      if state.internet_state == 'unreachable' else
                      'Ethernet, Wi-Fi, VPN, IPv4/IPv6 routes and DNS changes trigger checks. Networking is never modified.')
        elif name == 'tunnel':
            if not state._specs.get('tunnel'):
                label = 'Direct HTTPS / transport'
                managed = False
                actions = []
                lifecycle = 'unknown'
            else:
                label = 'Encrypted tunnel'
            if state.relay_state == 'connected':
                if lifecycle == 'running':
                    readiness = 'ready'
                    detail = 'Authenticated relay traffic confirms the transport path.'
                    checked = state.recovery['last_connected_at']
                else:
                    readiness = 'not_ready' if lifecycle == 'stopped' else 'unknown'
            elif lifecycle == 'running':
                # A previous successful observation is not evidence for the
                # current path after an outage or an unverified tunnel rebuild.
                readiness = 'unknown'
                detail = 'Process exists; end-to-end connectivity is not confirmed.'
            else:
                readiness = 'not_ready' if lifecycle == 'stopped' else 'unknown'
        elif name == 'supervisor':
            lifecycle, readiness, checked = 'running', 'ready', supervisor_state.stamp()
            detail = 'Background controller. Stays running with the dashboard after system shutdown.'
            desired = 'running'
        elif name == 'dashboard_ui':
            # The browser supplies its own observation, not the supervisor.
            detail = 'Browser connection is checked by this page, not inferred by the supervisor.'
            desired = 'external'
        elif name == 'vscode':
            lifecycle, readiness = 'unmanaged', 'unknown'
            desired = 'external'
            actions = ['open'] if state.editor_open else []
            detail = ('Opened on request from this dashboard. The supervisor never starts it automatically, restarts it, or observes it.'
                      if state.editor_open else
                      'Not opened by DeltaRelay. Set vscode.open_command to open it from this dashboard; the supervisor never starts it automatically, restarts it, or observes it.')
        elif name in ('plugin', 'storage', 'provider'):
            desired = 'external' if name == 'provider' else 'running'
            if name == 'plugin' and not observation:
                detail = 'Requires an explicit OpenCode location for read-only runtime verification. Configuration alone is not proof.'
            elif name == 'storage' and not observation:
                detail = ('Relay-owned request cache and response mailbox, read and written by the relay. '
                          'Response bytes are persisted before resumable delivery. No independent storage probe or reset action.')
            elif name == 'provider':
                detail = 'External service. Recovery never makes a test model request or changes sign-in.'
        elif name == 'remote_provider':
            desired = 'running'
            detail = observation.get('detail', 'Management availability is independent of relay connectivity.')
        if lifecycle not in ('running', 'stopped', 'starting', 'stopping', 'started', 'unknown', 'unmanaged'):
            lifecycle = 'unknown'
        activity = 'idle'
        if state.run and state.run['status'] == 'running' and state.run['current_component'] == name:
            activity = state.run['current_action']
        nodes.append({'id': name, 'label': label, 'kind': kind, 'group': group, 'owner': owner,
                      'managed': bool(managed), 'desired': desired, 'lifecycle': lifecycle,
                      'readiness': readiness, 'activity': activity, 'checked_at': checked,
                      'detail': detail, 'actions': actions})
    by_id = {node['id']: node for node in nodes}
    gate_configured = bool(state._managed.get('gate', False))
    backend_ready, backend_reason = gate_backend(state, by_id)
    local_ready, local_reason = gate_local(state, by_id)
    gate = by_id['gate']
    if not gate_configured:
        gate.update(lifecycle='unmanaged', readiness='unknown', managed=False,
                    desired='unmanaged', actions=[],
                    detail='Not configured. Add components.gate to run Varro or OpenChamber attach-only through the supervisor.')
    elif gate['lifecycle'] == 'stopped':
        gate['detail'] = ('Stopped. Varro and OpenChamber cannot connect. Desktop/TUI and the shared OpenCode '
                          'service are unaffected.')
    elif gate['readiness'] == 'ready':
        if backend_ready is True:
            gate['detail'] = 'Listener ready. Backend ready: gateway forwarding, OpenCode service, and plugin verified.'
        elif local_ready is False:
            gate['detail'] = (f'Listener ready. Local backend unavailable: {local_reason}. '
                              'Attached frontends will receive 503; the gate is not restarted.')
        elif backend_ready is False and local_ready is True:
            gate['detail'] = (f'Listener and local backend ready. Relay unavailable: {backend_reason}. '
                              'Attached frontends can open sessions; while the local gateway is running, prompts '
                              'wait for relay recovery within its retry window. The gate is not restarted.')
        elif backend_ready is False:
            gate['detail'] = (f'Listener ready. Relay unavailable: {backend_reason}. '
                              'Local readiness is not yet verified; the gate is not restarted.')
        else:
            gate['detail'] = 'Listener ready. Backend readiness not yet verified by independent probes.'
    else:
        gate['detail'] = 'Process state is not listener proof; gate liveness is not verified.'
    edges = []
    for source, target, relation, protocol in EDGES:
        status = 'unknown'
        evidence = state.observations.get(source + '_' + target, {})
        if (source, target) == ('gate', 'gateway'):
            status = by_id['gateway']['readiness']
        elif (source, target) == ('vscode', 'gate'):
            if not gate_configured or gate['readiness'] == 'unknown' or gate['lifecycle'] in ('unknown', 'unmanaged'):
                status = 'unknown'
            elif gate['readiness'] == 'ready':
                status = 'ready'
            else:
                status = 'not_ready'
        elif (source, target) == ('openchamber', 'gate'):
            frontend = by_id['openchamber']
            if (not gate_configured or not frontend['managed'] or
                    gate['readiness'] == 'unknown' or gate['lifecycle'] in ('unknown', 'unmanaged') or
                    frontend['lifecycle'] in ('unknown', 'unmanaged')):
                status = 'unknown'
            elif frontend['lifecycle'] in ('stopped', 'stopping') or gate['lifecycle'] == 'stopped':
                status = 'not_ready'
            elif gate['readiness'] == 'ready' and frontend['lifecycle'] in ('running', 'started'):
                status = 'ready'
            elif gate['readiness'] == 'not_ready':
                status = 'not_ready'
        elif (source, target) == ('gate', 'opencode'):
            if not gate_configured or gate['readiness'] == 'unknown' or local_ready is None:
                status = 'unknown'
            elif gate['readiness'] == 'ready' and local_ready:
                status = 'ready'
            else:
                status = 'not_ready'
        elif (source, target) == ('supervisor', 'gate'):
            status = 'ready' if gate['managed'] else 'unknown'
        elif evidence:
            status = evidence['readiness']
        elif (source, target) == ('tunnel', 'relay'):
            status = by_id['relay']['readiness']
        elif (source, target) == ('gateway', 'tunnel'):
            # Both endpoints and the supervisor's authenticated relay path are
            # verified independently. Two live processes alone are not enough.
            if by_id['gateway']['readiness'] == 'ready' and by_id['relay']['readiness'] == 'ready':
                status = 'ready'
        elif relation == 'contains':
            status = by_id[target]['readiness']
        elif relation == 'requires':
            status = by_id[target]['readiness']
        elif relation == 'manages':
            status = 'ready' if by_id[target]['managed'] else 'unknown'
        edges.append({'id': source + '_' + target, 'source': source, 'target': target,
                      'relation': relation, 'protocol': protocol, 'state': status})
    return {'version': 1, 'nodes': nodes, 'edges': edges,
            'intent': {'system': state.intent['system'], 'remote': state.intent['remote']},
            'network': dict(state.network), 'run': state.run_copy(),
            'shutdown_blockers': shutdown_blockers(state)}
