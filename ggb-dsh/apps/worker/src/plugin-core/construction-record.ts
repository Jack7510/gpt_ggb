import { pluginCoreConstructionRecordSchema, type PluginCoreConstructionRecord,
  type PluginCoreBuildBinding } from '@ggb-copilot/application'

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** Called only after acceptance. The domain request is already plugin-validated. */
export function createConstructionRecord(request: unknown, binding: PluginCoreBuildBinding): PluginCoreConstructionRecord {
  const domain = object(request)
  const plan = object(domain.plan)
  const zh = domain.locale === 'zh-CN'
  const lines = [zh ? '构造步骤与修改记录' : 'Construction steps and changes',
    `buildId: ${binding.buildId}`, `domainRequestDigest: ${binding.domainRequestDigest}`,
    `baseSha256: ${binding.baseSha256 ?? 'none'}`,
    zh ? '按原顺序记录构造输入；修改部分依赖原基线。核验脚本不包含在本记录中。'
      : 'Construction inputs in original order. Changes require the original baseline. Verification scripts are excluded.']
  const program = Array.isArray(plan.program) ? plan.program : []
  if (program.length > 0) lines.push('', zh ? '构造步骤（按顺序）' : 'Construction steps (ordered)')
  for (const [index, value] of program.entries()) {
    const step = object(value)
    lines.push('', `${index + 1}. [${String(step.mode ?? 'structured')}] ${String(step.id)}`)
    if (step.op === 'native' && typeof step.source === 'string') {
      lines.push(step.source)
      for (const key of ['outputs', 'initial']) {
        if (step[key] !== undefined) lines.push(`${key}: ${JSON.stringify(step[key])}`)
      }
    } else {
      const fields = ['id', 'op', 'x', 'y', 'name', 'args']
      lines.push(JSON.stringify(Object.fromEntries(fields.filter(key => step[key] !== undefined).map(key => [key, step[key]]))))
    }
  }
  const sections = [['updates', '值与坐标修改'], ['edits', '已有对象外观修改'],
    ['styles', '样式设置'], ['view', '视图设置'], ['display', '显示模式']] as const
  for (const [key, label] of sections) {
    const value = plan[key]
    if (value === undefined || Array.isArray(value) && value.length === 0) continue
    lines.push('', zh ? `${label} (${key})` : key, JSON.stringify(value))
  }
  return pluginCoreConstructionRecordSchema.parse({ schemaVersion: 1, origin: 'host-accepted-build',
    buildId: binding.buildId, domainRequestDigest: binding.domainRequestDigest, baseSha256: binding.baseSha256,
    text: lines.join('\n') + '\n' })
}
