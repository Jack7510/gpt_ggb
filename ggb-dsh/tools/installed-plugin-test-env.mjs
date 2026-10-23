/** Pass the verified global installation into each isolated Vitest worker. */
import { inject } from 'vitest'
process.env.GGB_PLUGIN_TEST_ROOT = inject('installedPluginRoot')
