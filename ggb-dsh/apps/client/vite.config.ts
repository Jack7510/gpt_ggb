import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// Same source as `tools/provision-geogebra.mjs`: the applet document asserts the
// injected runtime version against the provisioned one (§11 fixed GeoGebra runtime).
const runtime = JSON.parse(readFileSync('../../config/runtime-versions.json', 'utf8'))
const clientPackage = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }
const buildTimestamp = new Date().toISOString()

export default defineConfig({
  root: '.',
  plugins: [vue()],
  // The dev shell and the API are different origins here, while the deployment is
  // same-origin (§12). Proxying keeps `pnpm run dev` + `deploy/local/dev.sh` on the
  // production path shape instead of a dev-only CORS path. VS Code may expose Vite
  // through an arbitrary local port, so do not forward that browser-only Origin to
  // the API: the proxy is the development trust boundary.
  server: {
    proxy: {
      '/api/v3': {
        target: 'http://127.0.0.1:8081',
        changeOrigin: false,
        configure(proxy) {
          proxy.on('proxyReq', (request) => request.removeHeader('origin'))
        },
      },
    },
  },
  define: {
    GGB_CLIENT_VERSION: JSON.stringify(clientPackage.version),
    GGB_CLIENT_BUILD_TIMESTAMP: JSON.stringify(buildTimestamp),
    GGB_GEOGEBRA_VERSION: JSON.stringify(runtime.geogebra.version),
    GGB_GEOGEBRA_CODEBASE: JSON.stringify('/geogebra/HTML5/5.0/web3d/'),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
    rollupOptions: {
      input: {
        main: 'index.html',
        'geogebra-host': 'geogebra-host.html',
        // ES-module Service Worker, registered with `{ type: 'module' }`.
        'service-worker': 'src/pwa/service-worker.ts',
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === 'service-worker' ? 'service-worker.js' : 'assets/[name]-[hash].js',
      },
    },
  },
})
