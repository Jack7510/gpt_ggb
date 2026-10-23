import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./tools/installed-plugin-test-setup.mjs'],
    setupFiles: ['./tools/installed-plugin-test-env.mjs'],
    // The unified suite shares CPU and memory with the large Manual index.
    // Bound worker contention without relaxing individual test timeouts.
    maxWorkers: 4,
    include: ['apps/**/*.test.ts', 'packages/**/*.test.ts'],
  },
})
