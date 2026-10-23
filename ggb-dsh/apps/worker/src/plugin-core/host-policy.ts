/** Host-owned SDK permissions, applied after the independently released plugin. */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const HOST_DISABLED_PLUGINS = ['persistent-bash', 'persistent-pwsh', 'tool-fs',
  'tool-working-directory', 'str-replace-editor', 'session-log-deepseek',
  'plugin-package-inventory-deepseek'] as const

/** Plugin permissions cannot replace this final host-owned overlay. */
export async function writeHostPolicy(home: string): Promise<string> {
  const patch = [...HOST_DISABLED_PLUGINS.map(id => ({ id, disabled: true })),
    { insert: [{ id: 'ggb-host-tool-policy', name: fileURLToPath(
      new URL('../../lib/plugin-core/host-policy-plugin.js', import.meta.url)) }] }]
  const path = join(home, 'host-policy.patch.json')
  await writeFile(path, JSON.stringify(patch), { mode: 0o600 })
  return path
}
