/** Bootstrap facts the plugin-core-only Client needs before it starts. */
export interface PluginCoreBootstrapPayload {
  schemaVersion: number
  agentEngine: string
  provider?: { allowed: readonly string[] }
  limits?: Record<string, number>
  retention?: Record<string, number>
  pluginCore?: { activeRuns: number; maxConcurrentRuns: number } | null
}
