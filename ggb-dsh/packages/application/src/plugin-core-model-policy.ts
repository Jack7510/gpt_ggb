/** Server-owned model settings for the plugin-core construction engine. */
export const PLUGIN_CORE_MODEL_POLICY_V1 = {
  model: 'deepseek-flash',
  reasoning: 'high',
  // Four times the former cap; still below the DSH adapter default of 256,000.
  maxTokens: 49_152,
} as const
