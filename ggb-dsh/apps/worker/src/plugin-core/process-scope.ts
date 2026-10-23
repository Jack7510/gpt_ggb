import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
interface ProcessRow { pid: number; ppid: number; group: number; state: string }
async function snapshot(): Promise<ProcessRow[]> {
  const { stdout } = await exec('ps', ['-axo', 'pid=,ppid=,pgid=,stat='], { timeout: 1000 })
  return stdout.trim().split('\n').map(line => {
    const [pid, ppid, group, state] = line.trim().split(/\s+/u)
    return { pid: Number(pid), ppid: Number(ppid), group: Number(group), state: state! }
  })
}

/** Verify the process ownership prerequisites before accepting any run. */
export async function assertProcessScopeSupported(platform = process.platform,
  enumerate: () => Promise<unknown> = snapshot): Promise<void> {
  if (platform === 'win32') throw new Error('plugin_core_platform_unsupported')
  try { await enumerate() } catch { throw new Error('plugin_core_process_inventory_unavailable') }
}

/** Owns the executor group plus observed descendants with separate groups. */
export class PluginCoreProcessScope {
  private readonly owned = new Set<number>()
  private timer: NodeJS.Timeout | undefined
  private pending = Promise.resolve()
  private observable = true
  constructor(private readonly pid: number) {
    this.owned.add(pid)
    if (process.platform !== 'win32') this.timer = setInterval(() => {
      this.pending = this.pending.then(async () => { await this.scan() }).catch(() => { this.observable = false })
    }, 50)
  }
  private async scan(): Promise<ProcessRow[]> {
    const rows = await snapshot()
    let changed = true
    while (changed) {
      changed = false
      for (const row of rows) {
        if (!this.owned.has(row.pid) && (row.group === this.pid || this.owned.has(row.ppid))) {
          this.owned.add(row.pid); changed = true
        }
      }
    }
    return rows.filter(row => this.owned.has(row.pid) && !row.state.startsWith('Z'))
  }
  private signal(signal: NodeJS.Signals): void {
    try { process.kill(-this.pid, signal) } catch { /* already exited */ }
    for (const pid of this.owned) {
      try { process.kill(pid, signal) } catch { /* already exited */ }
    }
  }
  async terminate(): Promise<void> {
    try { await this.scan() } catch { this.observable = false }
    this.signal('SIGTERM')
  }
  async finish(): Promise<boolean> {
    if (this.timer !== undefined) clearInterval(this.timer)
    if (process.platform === 'win32') return false // no Job Object owner on this target
    await this.pending
    try {
      let remaining = await this.scan()
      if (remaining.length > 0) this.signal('SIGTERM')
      const deadline = Date.now() + 2500
      while (remaining.length > 0 && Date.now() < deadline) {
        if (Date.now() > deadline - 2000) this.signal('SIGKILL')
        await new Promise(resolve => setTimeout(resolve, 40))
        remaining = await this.scan()
      }
      return this.observable && remaining.length === 0
    } catch { return false }
  }
}
