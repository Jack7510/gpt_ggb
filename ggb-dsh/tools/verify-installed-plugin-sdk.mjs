/**
 * Verify an actual TGZ in a fresh install and SDK home, with all network denied
 * in the SDK child. This command initializes only; it never sends a prompt.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';

const workspace = fileURLToPath(new URL('../', import.meta.url));
const {values} = parseArgs({options: {
  'plugin-tgz': {type: 'string'}, 'sdk-root': {type: 'string'},
  output: {type: 'string'},
}});
assert(values['plugin-tgz'] && values['sdk-root'] && values.output,
    'Expected --plugin-tgz <archive> --sdk-root <installed SDK> --output <dir>');
const output = resolve(values.output);
await mkdir(output, {recursive: true});
const scratch = await mkdtemp(join(output, 'isolated-'));
const archive = resolve(values['plugin-tgz']);
const sdkRequire = createRequire(join(resolve(values['sdk-root']), 'package.json'));
const sdkMetadata = sdkRequire('@deepseek-ai/dsh-sdk-client/package.json');
const {DeepSeekHarness} = await import(pathToFileURL(
    sdkRequire.resolve('@deepseek-ai/dsh-sdk-client')).href);

/** Read a startup snapshot after handshake; missing probes are a test failure. */
async function snapshot(path) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try { return JSON.parse(await readFile(path, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await new Promise(done => setTimeout(done, 25));
    }
  }
  throw new Error('SDK startup probe missing');
}

/** Start and inspect one isolated SDK, then prove explicit close completed. */
async function inspect(installation, name) {
  const home = join(scratch, name);
  const probeOutput = join(scratch, name + '.json');
  const networkLog = join(scratch, name + '.network');
  await mkdir(home);
  await writeFile(networkLog, '');
  const fixtures = join(workspace, 'apps/worker/tests/fixtures');
  const probePatch = join(scratch, name + '.patch.yml');
  await writeFile(probePatch, JSON.stringify([{insert: [{
    id: 'installed-plugin-sdk-probe',
    name: join(fixtures, 'installed-plugin-sdk-probe.mjs'),
  }]}]));
  const harness = new DeepSeekHarness({profile: 'sdk-minimal',
    patches: [installation.serverPatch, probePatch],
    dshHome: home, processCwd: scratch, cwd: scratch,
    provider: 'deepseek-official', model: 'deepseek-flash',
    initializeTimeoutMs: 15000, requestTimeoutMs: 5000,
    shutdownTimeoutMs: 3000,
    env: {PATH: process.env.PATH, HOME: home, TMPDIR: scratch,
      GGB_DSH_SDK_VERSION: sdkMetadata.version,
      GGB_SDK_PROBE_OUTPUT: probeOutput,
      GGB_SDK_NETWORK_ATTEMPTS: networkLog,
      NODE_OPTIONS: '--import=' + pathToFileURL(
          join(fixtures, 'installed-plugin-network-deny.mjs')).href}});
  try {
    await harness.start();
    return await snapshot(probeOutput);
  } finally {
    await harness.close();
    assert.equal(await readFile(networkLog, 'utf8'), '');
  }
}

/** Validate actual registries, closed schemas and the exact bundled Skill. */
function checkSnapshot(observed, installation, workerSkill) {
  assert.equal(installation.executorProtocolVersion, 3);
  const expected = [...installation.modelFacingTools].sort();
  assert.deepEqual(observed.tools.map(tool => tool.name).sort(), expected);
  assert.deepEqual(observed.modelTools.map(tool => tool.name).sort(), expected);
  assert(observed.tools.every(tool =>
    tool.parameters.additionalProperties === false));
  const section = observed.sections.find(item =>
    item.name === 'ggb-construct:worker');
  assert.equal(section?.text, workerSkill);
  assert.equal(section.interpolate, false);
  const tools = new Map(observed.modelTools.map(tool => [tool.name, tool.parameters]));
  assert.deepEqual(tools.get('ggb_check').required, ['revision']);
  assert.deepEqual(tools.get('ggb_build').required, ['checkedRequestId']);
  assert.equal(tools.get('ggb_request').properties.requestText.type, 'string');
  assert.deepEqual(tools.get('ggb_request').required, ['requestText']);
  assert.equal(tools.get('ggb_inspect').properties.references.maxItems, 6);
  assert.equal(observed.providerKeyPresent, false);
  assert.deepEqual(observed.networkAttempts, []);
}

try {
  const install = join(scratch, 'install');
  await mkdir(install);
  // Offline uses the package manager's verified cache, never a source checkout.
  execFileSync('pnpm', ['--ignore-workspace', '--dir', install, 'add',
    '--offline', '--ignore-scripts', '--save-exact', archive],
  {stdio: 'pipe', env: {PATH: process.env.PATH, HOME: process.env.HOME,
    TMPDIR: scratch}});
  const requireInstalled = createRequire(join(install, 'package.json'));
  const entry = requireInstalled.resolve('ggb-plugins-dsh/installation');
  const {loadInstallation, loadWorkerSkill, assertDshCompatibility} =
      await import(pathToFileURL(entry).href);
  const installation = loadInstallation();
  assert(installation.root.startsWith(install + '/'));
  assertDshCompatibility(sdkMetadata.version);
  assert.throws(() => assertDshCompatibility('0.2.0-rc.2'));
  const workerSkill = loadWorkerSkill();
  const first = await inspect(installation, 'home-one');
  checkSnapshot(first, installation, workerSkill);
  await rm(join(scratch, 'home-one'), {recursive: true});
  const second = await inspect(installation, 'home-two');
  checkSnapshot(second, installation, workerSkill);
  const result = {ok: true, sdkVersion: sdkMetadata.version,
    nodeVersion: process.version, pluginVersion: installation.pluginVersion,
    packageSha256: createHash('sha256').update(await readFile(archive))
        .digest('hex'),
    declaredRuntimeIdentity: installation.runtimeIdentity,
    tools: installation.modelFacingTools,
    executorProtocolVersion: installation.executorProtocolVersion,
    workerSkillSha256: installation.workerSkillSha256,
    initializedHomes: 2, firstHomeRemoved: true,
    harnessesClosed: true, providerRequests: 0,
    networkAttempts: 0, browserStarted: false};
  await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error);
  if (error.stdout) console.error(error.stdout.toString());
  if (error.stderr) console.error(error.stderr.toString());
  process.exitCode = 1;
}
