import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RunError } from '@ggb-copilot/application'
import { startApiServer, type RunningApiServer } from '../src/http/http-server.js'
import { createStaticAssets } from '../src/http/static-assets.js'

const RUNTIME = {
  version: '5.4.929.3',
  source: 'https://download.geogebra.org/installers/5.4/geogebra-math-apps-bundle-5-4-929-3.zip',
  sha256: 'a'.repeat(64),
  compatibility: {
    patchId: 'directrix-path-origin-v1', sourceVersion: '5.4.929.3',
    asset: 'HTML5/5.0/web3d/deferredjs/38DDB4543208AF14503E6553B520534C/6.cache.js',
    originalSha256: 'b'.repeat(64),
    patchedSha256: createHash('sha256').update('// patched\n').digest('hex'),
  },
}

const root = mkdtempSync(join(tmpdir(), 'ggb-static-'))
const dist = join(root, 'dist')
const outside = join(root, 'secret.txt')

function write(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

function runtimeManifest(overrides: Record<string, unknown> = {}): void {
  writeFileSync(join(dist, 'geogebra-runtime-manifest.json'), JSON.stringify({
    schemaVersion: 1,
    version: RUNTIME.version,
    source: RUNTIME.source,
    archiveSha256: RUNTIME.sha256,
    compatibility: RUNTIME.compatibility,
    ...overrides,
  }))
}

function writeRuntimeVersions(): string {
  const path = join(root, 'runtime-versions.json')
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, geogebra: RUNTIME }))
  return path
}

write(join(dist, 'index.html'), '<!doctype html><title>ggb</title>')
write(join(dist, 'geogebra-host.html'), '<!doctype html><title>ggb applet</title>')
write(join(dist, 'assets', 'app-abc123.js'), 'export const ok = true\n')
write(join(dist, 'manifest.webmanifest'), '{"name":"ggb"}')
write(join(dist, 'geogebra', 'deployggb.js'), 'window.GGB = true\n')
write(join(dist, 'geogebra', 'HTML5', '5.0', 'web3d', 'web3d.nocache.js'), '// web3d\n')
write(join(dist, 'geogebra', RUNTIME.compatibility.asset), '// patched\n')
write(outside, 'do-not-serve')
runtimeManifest()

describe('static assets', () => {
  const assets = createStaticAssets({
    clientDistDir: dist,
    geogebraRoot: null,
    runtimeVersionsPath: writeRuntimeVersions(),
  })!
  let server: RunningApiServer
  let base: string

  beforeAll(async () => {
    server = await startApiServer({
      port: 0,
      maxBodyBytes: 1024,
      allowedOrigin: null,
      handler: () => {
        throw new RunError('not_found', 'unknown endpoint')
      },
      staticAssets: assets,
    })
    base = `http://127.0.0.1:${server.port}`
  })
  afterAll(async () => {
    await server.close()
  })

  it('serves the client shell, hashed assets and the fixed runtime with §11 caching', async () => {
    const shell = await fetch(`${base}/`)
    expect(shell.status).toBe(200)
    expect(shell.headers.get('content-type')).toContain('text/html')
    expect(shell.headers.get('cache-control')).toBe('no-cache')
    expect(await shell.text()).toContain('ggb')

    const hashed = await fetch(`${base}/assets/app-abc123.js`)
    expect(hashed.status).toBe(200)
    expect(hashed.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')

    const runtime = await fetch(`${base}/geogebra/deployggb.js`)
    expect(runtime.status).toBe(200)
    expect(runtime.headers.get('content-type')).toContain('text/javascript')
    expect(runtime.headers.get('cache-control')).toBe('public, max-age=86400')
  })

  it('answers deep links with the shell instead of a 404', async () => {
    const response = await fetch(`${base}/sessions/abc/messages/42`)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('ggb')
  })

  it('gives the shell the minimum §12 policy and confines GeoGebra privileges to the applet document', async () => {
    const shell = await fetch(`${base}/`)
    const shellCsp = shell.headers.get('content-security-policy') ?? ''
    expect(shellCsp).toContain("script-src 'self'")
    expect(shellCsp).toContain("object-src 'none'")
    expect(shellCsp).not.toContain('unsafe-eval')
    expect(shellCsp).not.toContain('unsafe-inline')

    const deepLink = await fetch(`${base}/sessions/abc`)
    expect(deepLink.headers.get('content-security-policy')).toBe(shellCsp)

    const applet = await fetch(`${base}/geogebra-host.html`)
    const appletCsp = applet.headers.get('content-security-policy') ?? ''
    expect(appletCsp).toContain("'unsafe-eval'")
    expect(appletCsp).toContain("frame-ancestors 'self'")
    expect(appletCsp).not.toBe(shellCsp)

    // Non-document assets carry no policy of their own.
    const hashed = await fetch(`${base}/assets/app-abc123.js`)
    expect(hashed.headers.get('content-security-policy')).toBeNull()
  })

  it('never serves an api path statically', async () => {
    const response = await fetch(`${base}/api/v3/runs/bogus`)
    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toContain('application/json')
  })

  it('refuses traversal out of the served roots', async () => {
    const traversal = await fetch(`${base}/geogebra/%2e%2e%2f%2e%2e%2fsecret.txt`)
    expect(await traversal.text()).not.toContain('do-not-serve')
  })

  it('refuses to follow a symlinked asset', async () => {
    symlinkSync(outside, join(dist, 'geogebra', 'linked.js'))
    const response = await fetch(`${base}/geogebra/linked.js`)
    expect(response.status).toBe(404)
  })
})

describe('static asset boot validation', () => {
  for (const compatibility of [undefined, { ...RUNTIME.compatibility, patchedSha256: 'a'.repeat(64) },
    { ...RUNTIME.compatibility, sourceVersion: 'other' }, { ...RUNTIME.compatibility, asset: '../outside' }]) {
    it('rejects missing or forged patch audit metadata', () => {
      runtimeManifest({ compatibility })
      expect(() => createStaticAssets({ clientDistDir: dist, geogebraRoot: null,
        runtimeVersionsPath: writeRuntimeVersions() })).toThrow('geogebra_runtime_compatibility_mismatch')
      runtimeManifest()
    })
  }

  it('rejects original or partial engine bytes despite a valid manifest', () => {
    for (const content of ['// original\n', 'partial']) {
      write(join(dist, 'geogebra', RUNTIME.compatibility.asset), content)
      expect(() => createStaticAssets({ clientDistDir: dist, geogebraRoot: null,
        runtimeVersionsPath: writeRuntimeVersions() })).toThrow('geogebra_runtime_asset_digest_mismatch')
    }
    write(join(dist, 'geogebra', RUNTIME.compatibility.asset), '// patched\n')
  })

  it('rejects an engine directory escaping the root even when its bytes match', () => {
    const directory = join(dist, 'geogebra', RUNTIME.compatibility.asset, '..')
    const escaped = join(root, 'escaped-engine')
    renameSync(directory, escaped)
    symlinkSync(escaped, directory, 'dir')
    try {
      expect(() => createStaticAssets({ clientDistDir: dist, geogebraRoot: null,
        runtimeVersionsPath: writeRuntimeVersions() })).toThrow('geogebra_runtime_compatibility_asset_invalid')
    } finally {
      rmSync(directory)
      renameSync(escaped, directory)
    }
  })

  it('rejects a runtime whose manifest does not match the pinned release', () => {
    runtimeManifest({ archiveSha256: 'b'.repeat(64) })
    expect(() => createStaticAssets({
      clientDistDir: dist,
      geogebraRoot: null,
      runtimeVersionsPath: writeRuntimeVersions(),
    })).toThrow('geogebra_runtime_manifest_mismatch')
    runtimeManifest()
  })

  it('rejects a runtime missing a required file', () => {
    const incomplete = join(root, 'incomplete')
    write(join(incomplete, 'index.html'), '<!doctype html>')
    write(join(incomplete, 'geogebra', 'deployggb.js'), '// only deployggb\n')
    writeFileSync(join(incomplete, 'geogebra-runtime-manifest.json'), JSON.stringify({
      schemaVersion: 1,
      version: RUNTIME.version,
      source: RUNTIME.source,
      archiveSha256: RUNTIME.sha256,
    }))
    expect(() => createStaticAssets({
      clientDistDir: incomplete,
      geogebraRoot: null,
      runtimeVersionsPath: writeRuntimeVersions(),
    })).toThrow('geogebra_runtime_incomplete')
  })

  it('is disabled when no client build is configured', () => {
    expect(createStaticAssets({
      clientDistDir: null,
      geogebraRoot: null,
      runtimeVersionsPath: writeRuntimeVersions(),
    })).toBeNull()
  })
})
