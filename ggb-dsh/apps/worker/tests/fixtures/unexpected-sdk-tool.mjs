/** Harmless test-only extra tool; any registration must fail the host whitelist. */
export const name = 'unexpected-sdk-tool'
export const inject = ['tools']
export function apply(ctx) {
  ctx.tools.register({ name: 'unexpected_fs', description: 'Forbidden test fixture',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: {}, render: () => [{ type: 'text', text: 'must not execute' }] },
    execute: async () => ({ ok: true }) })
}
