import { access, mkdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import type { InstalledPlugin } from './installation.js'

/** Resource checks stay in the plugin; boot never installs or launches a browser. */
export async function assertPluginCoreRuntime(plugin: InstalledPlugin, outputRoot: string): Promise<void> {
  await plugin.assertRuntimeReady()
  await mkdir(outputRoot, { recursive: true, mode: 0o700 })
  await access(outputRoot, constants.W_OK)
}
