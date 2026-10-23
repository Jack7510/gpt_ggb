/** Enforce the host tool boundary using public SDK registry and guard APIs. */
export const name = 'ggb-host-tool-policy'
export const inject = ['tools', 'llm']
const ALLOWED = ['ggb_build', 'ggb_check', 'ggb_inspect', 'ggb_request']
interface ToolSchema { name: string }
interface StreamOptions { tools?: ToolSchema[] }
interface Context {
  tools: {
    schemas(): ToolSchema[]
    guard(check: (execution: { name: string }) => string | undefined): unknown
  }
  on(event: 'llm/stream', handler: (options: StreamOptions,
    next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>): unknown
}

function assertTools(tools: ToolSchema[]): void {
  const names = tools.map(tool => tool.name).sort()
  if (JSON.stringify(names) !== JSON.stringify(ALLOWED)) throw new Error('plugin_core_host_tool_policy_violation')
}

/** Reject extra or missing tools before any provider request; deny every other execution. */
export function apply(ctx: Context): void {
  ctx.tools.guard(execution => ALLOWED.includes(execution.name) ? undefined : 'plugin_core_host_tool_not_allowed')
  ctx.on('llm/stream', (options, next) => (async function* () {
    assertTools(ctx.tools.schemas())
    if (options.tools) assertTools(options.tools)
    yield* next()
  })())
}
