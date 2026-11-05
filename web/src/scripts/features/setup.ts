import { type SetupStatus } from "../../lib/setup.js"
import { controlError, sendControl, type SystemStatus } from "../../lib/system.js"
import { requiredById } from "../dom.js"

export function mountSetup(root: HTMLElement, onRefresh: () => void, onAction: () => void) {
  const form = requiredById<HTMLFormElement>(root, "remote-setup-form")
  const provider = requiredById<HTMLSelectElement>(root, "setup-provider")
  const target = requiredById<HTMLInputElement>(root, "setup-target")
  const directory = requiredById<HTMLInputElement>(root, "setup-directory")
  const sshPort = requiredById<HTMLInputElement>(root, "setup-ssh-port")
  const remotePort = requiredById<HTMLInputElement>(root, "setup-remote-port")
  const submit = requiredById<HTMLButtonElement>(root, "setup-submit")
  const detail = requiredById(root, "setup-detail")
  const badge = requiredById(root, "setup-state")
  let status: SetupStatus | null = null
  let system: SystemStatus | null = null
  let stale = true
  let pending = false
  let message = ""
  let restored = false

  function render() {
    root.hidden = !status?.required
    const disabled = stale || pending || !status?.available || !system?.managed || Boolean(system?.recovery.busy) || Boolean(status?.busy)
    for (const field of [provider, target, directory, sshPort, remotePort]) field.disabled = disabled || Boolean(status?.target)
    submit.disabled = disabled
    submit.textContent = status?.busy || pending ? "Setting up remote host…" : status?.target ? "Resume remote setup…" : "Set up remote host…"
    badge.textContent = status?.busy ? "Installing…" : status?.last_error ? "Setup failed" : "Setup required"
    requiredById(root, "setup-target-label").textContent = provider.value === "codespaces" ? "Existing Codespace name" : "SSH alias or user@host"
    requiredById<HTMLElement>(root, "setup-ssh-port-label").hidden = provider.value === "codespaces"
    detail.textContent = stale ? "Setup status is stale. Refresh before installing anything." : status?.busy ? "Setup is running independently of this page. Follow actual commands and errors in System activity." : message || (status?.last_error ? controlError(status.last_error) : status?.target ? "A previous setup was interrupted. Resume uses the same credentials, identity, and remote destination." : "Select a host, then confirm installation. Nothing remote is changed before confirmation.")
  }

  provider.addEventListener("change", render)
  form.addEventListener("submit", (event) => {
    event.preventDefault()
    void install()
  })

  async function install() {
    if (submit.disabled || !system || !status?.available || stale) return
    if (!window.confirm(`Install DeltaRelay on ${target.value} in ${directory.value}? Only a new private deployment (or this same interrupted setup) is allowed. A stopped Codespace may be resumed and incur compute charges. No existing deployment will be replaced.`)) return
    pending = true
    message = "Submitting remote setup…"
    render()
    try {
      await sendControl("setup", { provider: provider.value, target: target.value.trim(), remote_directory: directory.value.trim(), ssh_port: Number(sshPort.value), remote_port: Number(remotePort.value), confirmed: true }, system.csrf_token)
      message = "Setup accepted. Follow System activity; it continues even if this page closes."
      onAction()
    } catch (error) {
      message = error instanceof Error ? error.message : "Setup could not be confirmed. Refresh before retrying."
    } finally {
      pending = false
      // Do not allow a second submission until new server status confirms state.
      stale = true
      render()
      onRefresh()
    }
  }

  return {
    update(next: SetupStatus | null, nextSystem: SystemStatus | null, nextStale: boolean) {
      if (next) status = next
      system = nextSystem
      stale = nextStale
      if (!restored && status?.target) {
        const saved = status.target
        provider.value = saved.provider
        target.value = saved.target
        directory.value = saved.remote_directory
        sshPort.value = String(saved.ssh_port)
        remotePort.value = String(saved.remote_port)
        restored = true
      }
      render()
    },
  }
}
