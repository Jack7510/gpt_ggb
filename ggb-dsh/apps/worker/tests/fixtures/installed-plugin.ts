import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { loadInstalledToolProtocol } from '../../src/plugin-core/tool-protocol.js'

export const installedRoot = process.env.GGB_PLUGIN_TEST_ROOT!
if (!installedRoot) throw new Error('verified_test_installation_missing')
const require = createRequire(join(installedRoot, 'package.json'))
export const installedSchemas = await import(pathToFileURL(require.resolve('ggb-plugins-dsh/schemas')).href)
export const toolProtocol = await loadInstalledToolProtocol(installedRoot)
export const serverPatch = require.resolve('ggb-plugins-dsh/server.patch.yml')
