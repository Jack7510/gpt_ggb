/** Test-only inspection inside a real SDK Server; never enqueues a model turn. */
import {writeFile} from 'node:fs/promises';

export const name = 'installed-plugin-sdk-probe';
export const inject = ['tools', 'systemPrompt'];

/** Observe the final loaded registry and assembled prompt at startup. */
export async function apply(ctx) {
  const deadline = Date.now() + 5000;
  while (!ctx.tools.get('ggb_build')) {
    if (Date.now() > deadline) throw new Error('ggb server adapter missing');
    await new Promise(done => setTimeout(done, 10));
  }
  const assembly = await ctx.systemPrompt.assemble();
  await writeFile(process.env.GGB_SDK_PROBE_OUTPUT, JSON.stringify({
    tools: ctx.tools.schemas(),
    sections: assembly.sections,
    modelTools: assembly.tools,
    networkAttempts: globalThis[Symbol.for('ggb.sdk.networkAttempts')],
    providerKeyPresent: Boolean(process.env.DEEPSEEK_API_KEY),
  }));
}
