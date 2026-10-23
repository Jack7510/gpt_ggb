import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import { sharedPackages } from './tools/shared-packages.mjs'

const tools = ['tools/build-ggb-manual-index*.mjs', 'tools/agent-reading-hints.mjs',
  'tools/check-package.mjs', 'tools/quality-shared.mjs', 'tools/shared-packages.mjs',
  'tools/workspace-boundaries.test.mjs', 'eslint.config.js']
const files = [...sharedPackages.map(name => `packages/${name}/**/*.ts`), ...tools]

export default tseslint.config(
  { ignores: ['**/lib/**', '**/node_modules/**'] },
  ...[js.configs.recommended, ...tseslint.configs.recommended].map(config => ({ ...config, files })),
  {
    files: tools,
    languageOptions: { globals: { process: 'readonly', console: 'readonly' } },
  },
  {
    files,
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
)
