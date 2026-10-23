import { createApp } from 'vue'

import App from './app/App.vue'
import { ClientRuntime } from './app/runtime.js'
import { createIframeAppletPort } from './geogebra/host.js'
import { createMemoryArtifactStore, createOpfsArtifactStore, type ArtifactStore } from './persistence/opfs-artifacts.js'
import { createMemoryDatabase, isIndexedDbAvailable, openClientDatabase, type ClientDatabase } from './persistence/indexeddb.js'
import { registerServiceWorker } from './pwa/register-service-worker.js'
import { localeFromBrowser } from './app/localization.js'
import type { PluginCoreBootstrapPayload } from './runtime/plugin-core-bootstrap.js'

/** Same-origin by default; a deployment may pin an explicit API origin (§12). */
function apiBaseUrl(): string {
  const configured = document.querySelector('meta[name="ggb-api-base-url"]')?.getAttribute('content')
  return configured === null || configured === undefined || configured.trim().length === 0 ? '' : configured.trim()
}

async function openDatabase(): Promise<ClientDatabase> {
  if (!isIndexedDbAvailable()) return createMemoryDatabase()
  try {
    return await openClientDatabase(globalThis.indexedDB)
  } catch {
    return createMemoryDatabase()
  }
}

async function openArtifacts(): Promise<ArtifactStore> {
  if (typeof navigator === 'undefined' || navigator.storage?.getDirectory === undefined) {
    return createMemoryArtifactStore()
  }
  try {
    return await createOpfsArtifactStore()
  } catch {
    return createMemoryArtifactStore()
  }
}

async function loadBootstrap(baseUrl: string): Promise<PluginCoreBootstrapPayload> {
  const response = await fetch(`${baseUrl}/api/v3/bootstrap`, {
    headers: { accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`bootstrap_failed:${String(response.status)}`)
  return await response.json() as PluginCoreBootstrapPayload
}

async function bootstrap(): Promise<void> {
  const presentationLocale = localeFromBrowser()
  document.documentElement.lang = presentationLocale
  const baseUrl = apiBaseUrl()
  let bootstrapPayload: PluginCoreBootstrapPayload
  try {
    bootstrapPayload = await loadBootstrap(baseUrl)
  } catch (error) {
    const app = document.querySelector<HTMLDivElement>('#app')
    if (app !== null) {
      app.textContent = 'GGB Agent 暂时不可用：无法读取服务配置。'
    }
    console.error(error)
    return
  }
  if (bootstrapPayload.agentEngine !== 'plugin_core') {
    throw new Error('bootstrap_agent_engine_invalid')
  }
  const database = await openDatabase()
  const artifacts = await openArtifacts()
  const applet = createIframeAppletPort()
  const runtime = new ClientRuntime({
    baseUrl,
    fetch: globalThis.fetch.bind(globalThis),
    db: database,
    artifacts,
    applet: applet.port,
    subtle: crypto.subtle,
    random: crypto,
    now: () => new Date().toISOString(),
    newId: () => crypto.randomUUID(),
    reload: () => globalThis.location.reload(),
    createChannel: (name) => new BroadcastChannel(name),
    locks: navigator.locks,
    presentationLocale,
  })
  await runtime.init()

  const app = createApp(App, { runtime, appletElement: applet.element,
    disposeRuntimeOnUnmount: !import.meta.env.DEV })
  app.mount('#app')

  if (!import.meta.env.DEV) {
    void registerServiceWorker({
      hasUnsettledWork: () => runtime.hasUnsettledWork(),
      reload: () => globalThis.location.reload(),
    })
  }
}

void bootstrap()
