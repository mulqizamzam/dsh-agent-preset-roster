#!/usr/bin/env node
// e2e/roster.e2e.mjs — end-to-end proof for the file-driven preset roster.
//
// Boots the SHIPPED web composition in-process — the same boot `dsh web`
// performs, minus the port-binding and network rows — with the real provider
// plugin linked into a throwaway profile, then reads the agent-preset
// registry exactly the way the Web GUI does (`agentPresets.list`), and
// composes Agents under presets (`agentPresets.mount`).
//
// Cases:
//   happy    — provider = <pluginDir> (fixed dsh-multi-agent-harness).
//              Asserts: 16 presets registered (20 in roster with the 4
//              shipped ones), none broken, and `orchestrator` + `role-cto`
//              compose Agents with tools and their own persona prefix.
//   armed    — same boot plus a preset declared before the provider whose
//              composition injects a service no row provides. That preset's
//              mounted tree has a pending row: the arming condition for the
//              boot deadlock that `await agentPresets.list()` inside
//              `apply()` carried (the registry's diagnostic then awaits the
//              host Loader, which waits on the plugin's own row). Asserts:
//              the boot still finishes AND the deferred audit reports the
//              armed preset broken (the boot-log gap close).
//   isolate  — provider = <pluginDir> (dsh-agent-preset-roster) over a
//              fixture root with three good presets, one malformed
//              composition, and one directory without a composition file.
//              Asserts: the three good presets register, the malformed one
//              is logged per-preset, and no preset is silently dropped from
//              the roster.
//
// Exit codes: 0 pass, 1 fail, 2 usage, 42 vulnerable-proof (boot hung).
//
// Usage:
//   node e2e/roster.e2e.mjs happy   <pluginDir>
//   node e2e/roster.e2e.mjs armed   <pluginDir>
//   node e2e/roster.e2e.mjs isolate <pluginDir>
//
// Environment:
//   DSH_HARNESS_ROOT  harness checkout (default /home/administrator/deepseek-harness)

import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO_ROOT = process.env.DSH_HARNESS_ROOT ?? '/home/administrator/deepseek-harness'
const HARNESS_LIB = join(REPO_ROOT, 'packages/boot/app-boot/lib/index.js')
const INSTALL_ANCHOR = join(REPO_ROOT, 'apps/cli/package.json')
const BASE_PATCH = join(REPO_ROOT, 'packages/bundle/base/cordis.patch.yml')
const WEB_BUNDLE = join(REPO_ROOT, 'packages/bundle/web-app')

const appBootRequire = createRequire(HARNESS_LIB)
const appBoot = appBootRequire('@deepseek-ai/dsh-app-boot')
const { boot, initProfile, createRuntimeResolution, loadProfile, PluginPackages,
  bundlePatchPaths, loadOverlayPatches } = appBoot
const { provideCmdline } = createRequire(INSTALL_ANCHOR)('@deepseek-ai/dsh-cmdline')

const SHIPPED_PRESETS = ['cordis', 'minimal', 'ptc', 'standard']
const ROLE_IDS = ['argus', 'atlas', 'badsector', 'cfo', 'cto', 'kai', 'ledger',
  'nova', 'quill', 'scout', 'somad', 'talon', 'tess', 'vera', 'zeko']
const PLUGIN_PRESETS = [...ROLE_IDS.map(id => `role-${id}`), 'orchestrator']

/** Tagged boot lines the provider plugin writes to stderr. */
const bootLines = []
const realWrite = process.stderr.write.bind(process.stderr)
process.stderr.write = (chunk, ...rest) => {
  bootLines.push(String(chunk))
  return realWrite(chunk, ...rest)
}

/** PatchOptions disabling every row that binds a port, touches the network,
 *  or writes outside the throwaway profile home. Copied in spirit from the
 *  harness's own web-agent-presets e2e: everything that decides an agent's
 *  capabilities stays the real thing. */
function baseOverrides(home) {
  return [
    { id: 'storage-json', config: { root: join(home, 'storages') } },
    { id: 'session-persistence-jsonl', config: { root: join(home, 'sessions') } },
    { id: 'webserver', disabled: true },
    { id: 'hmr', disabled: true },
    { id: 'web-runtime', disabled: true },
    { id: 'session-telemetry-otel', disabled: true },
    { id: 'modules', disabled: true },
    { id: 'connection', disabled: true },
    { id: 'session-log-download', disabled: true },
    { id: 'open-in-app', disabled: true },
    { id: 'client-hmr', disabled: true },
    { id: 'directory-picker', disabled: true },
    { insert: [
      { id: 'directory-picker-browse', name: '@deepseek-ai/dsh-host-directory-picker-browse' },
      { id: 'ui-directory-picker-browse', name: '@deepseek-ai/dsh-client-ui-directory-picker-browse' },
    ] },
    { id: 'agent-preset-registry', config: { default: 'standard' } },
  ]
}

/** Boot the shipped web composition over one throwaway profile home.
 *
 *  `profilePackages` are linked into the profile's node_modules; each must
 *  be a bundle package (package.json `dsh.bundle.patch`) so its own patch
 *  row is mounted. `extraPatches` ride the last patch layer. */
async function bootWeb(home, extraPatches = [], profilePackages = [], profileBundles) {
  const storageRoot = join(home, 'storages')
  const overrides = [...baseOverrides(home), ...extraPatches]
  const profileDir = join(home, 'profiles', 'spec')
  await mkdir(profileDir, { recursive: true })
  if (profileBundles === undefined) {
    initProfile(profileDir, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  }
  // Model pnpm's package link for the profile's own dependency surface.
  for (const packageDir of profilePackages) {
    const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'))
    const link = join(profileDir, 'node_modules', manifest.name)
    await mkdir(join(link, '..'), { recursive: true })
    await symlink(packageDir, link, 'junction')
  }
  let profile = {
    skippedBundles: [], name: 'spec', dir: profileDir,
    layers: [], patchPath: join(profileDir, 'cordis.patch.yml'), patches: [],
  }
  const webBundle = JSON.parse(await readFile(join(WEB_BUNDLE, 'package.json'), 'utf8')).dsh.bundle
  const webPatchPaths = bundlePatchPaths(WEB_BUNDLE, webBundle)
  let bundlePatches = [
    ...loadOverlayPatches('dsh-test', BASE_PATCH),
    ...webPatchPaths.flatMap(file => loadOverlayPatches('dsh-test', file)),
  ]
  if (profileBundles !== undefined) {
    await writeFile(join(profileDir, 'package.json'), JSON.stringify({
      private: true,
      dependencies: Object.fromEntries(profileBundles.map(name => [name, 'workspace:*'])),
      dsh: { profile: { bundles: profileBundles } },
    }, null, 2) + '\n')
    profile = loadProfile('dsh-test', 'spec', INSTALL_ANCHOR, home, { userLayer: false })
    bundlePatches = profile.layers.flatMap(layer => layer.patches)
  }
  // Deployment defaults live in a bundle beneath the profile patch, so the
  // overrides below are not shadowed by an overlay.
  const fixtureName = 'dsh-roster-e2e-defaults'
  const fixtureDir = join(profileDir, 'node_modules', fixtureName)
  await mkdir(fixtureDir, { recursive: true })
  await writeFile(join(fixtureDir, 'package.json'), JSON.stringify({
    name: fixtureName, version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } },
  }))
  await writeFile(join(fixtureDir, 'cordis.patch.yml'), JSON.stringify(overrides))
  const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
  manifest.dsh.profile.bundles.push(fixtureName)
  await writeFile(join(profileDir, 'package.json'), JSON.stringify(manifest))
  const resolution = await createRuntimeResolution({ installAnchor: INSTALL_ANCHOR, home, profile })
  const rootConfig = join(profileDir, 'cordis.yml')
  await writeFile(rootConfig, '[]\n')
  return await boot('dsh-test', rootConfig, [...bundlePatches, ...overrides], async (bootCtx) => {
    bootCtx.provide('profileContext', {
      name: 'spec', dir: profileDir, patchPath: profile.patchPath,
      installAnchor: INSTALL_ANCHOR, home, cwd: home,
      startedBundles: profileBundles ?? ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
      overlays: [], telemetryDisabledEnv: '1',
    })
    await bootCtx.plugin(PluginPackages, { resolution })
    bootCtx.provide('connection', {
      fetch: { register: () => () => {} },
      rpc: { intercept: () => () => {} },
    })
    provideCmdline(bootCtx, { args: [], exit: () => {} })
  })
}

/** A fixture package whose plugin injects a service no row provides, so its
 *  fiber settles with a pending inject — the audit state that arms the
 *  deadlock once a roster read runs inside a host row's own activation.
 *  Declared as a bundle (empty patch) so the runtime resolution can resolve
 *  it from the preset scope exactly like a real profile dependency. */
async function writeArmedFixture(home) {
  const dir = join(home, 'fixture-missing-inject')
  await mkdir(dir, { recursive: true })
  // The fixture lives outside the harness tree, so its Service import uses
  // the harness's own resolved cordis module path rather than a bare name.
  const cordisEntry = appBootRequire.resolve('@deepseek-ai/cordis')
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: 'fixture-missing-inject', version: '1.0.0', type: 'module', main: 'index.js',
    dsh: { bundle: { patch: 'cordis.patch.yml' } },
  }))
  await writeFile(join(dir, 'cordis.patch.yml'), '[]\n')
  await writeFile(join(dir, 'index.js'), [
    `import { Service } from ${JSON.stringify(pathToFileURL(cordisEntry).href)}`,
    `export default class FixtureMissingInject extends Service {`,
    `  static inject = ['serviceThatNoRowProvides']`,
    `}`,
    ``,
  ].join('\n'))
  return dir
}

/** The preset declaration row that mounts the armed fixture inside a preset
 *  scope, mirroring how the web-app bundle declares the shipped presets. */
const ARMED_PRESET_ROW = {
  insert: [{
    id: 'preset-armed',
    name: '@deepseek-ai/dsh-agent-preset',
    config: {
      id: 'armed',
      plugins: [{ id: 'armed-missing', name: 'fixture-missing-inject' }],
    },
  }],
}

/** Fixture `.agent-presets` root for the isolate case: three good presets,
 *  one malformed composition, one directory with no composition file, and one
 *  colliding with a shipped preset id (the registry rejects the duplicate
 *  atomically; the per-preset catch must absorb it as a skip). */
async function writeIsolateRoot() {
  const root = await mkdtemp(join(tmpdir(), 'roster-e2e-root-'))
  const good = async (id, prefix) => {
    await mkdir(join(root, id), { recursive: true })
    await writeFile(join(root, id, 'agent.cordis.yml'),
      `- id: persona\n  name: '@deepseek-ai/dsh-persona'\n  config:\n    prefix: ${prefix}\n`)
    await writeFile(join(root, id, 'preset.yml'), `description: e2e fixture preset ${id}\n`)
  }
  await good('alpha', 'You are alpha.')
  await good('beta', 'You are beta.')
  await good('gamma', 'You are gamma.')
  await mkdir(join(root, 'malformed'), { recursive: true })
  await writeFile(join(root, 'malformed', 'agent.cordis.yml'),
    `- id: persona\n  name: "unterminated\n`)
  await mkdir(join(root, 'no-composition'), { recursive: true })
  await good('standard', 'You are the colliding copy.')
  return root
}

/** Wait until the provider's deferred roster audit line lands on stderr. */
async function waitForAudit(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const line = bootLines.join('').split('\n').find(l => l.includes('] roster audit:'))
    if (line) return line.trim()
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return null
}

/** Compose one Agent under `presetId` and read back what it can see. */
async function composeAgent(ctx, presetId, sessionSuffix) {
  const handle = await ctx.agents.create({
    sessionId: `roster-e2e-${sessionSuffix}`,
    setup: (agentCtx) => ctx.agentPresets.mount(agentCtx, presetId).then(() => undefined),
  })
  try {
    const tools = ctx.tools.schemas(handle.agent).map(schema => schema.name).sort()
    const sections = (await ctx.systemPrompt.assemble({ scope: handle.agent })).sections
      .filter(section => section.name === 'deployment:persona-prefix')
    return { tools, persona: sections.map(section => section.text).join('\n') }
  } finally {
    await handle.dispose()
  }
}

function report(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  return ok
}

// ── cases ────────────────────────────────────────────────────────────────

async function caseHappy(pluginDir) {
  const home = await mkdtemp(join(tmpdir(), 'roster-e2e-happy-'))
  const ctx = await bootWeb(home, [], [pluginDir],
    ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-multi-agent-harness'])
  try {
    const rows = await ctx.agentPresets.list()
    const ids = rows.map(row => row.id).sort()
    const broken = rows.filter(row => row.broken !== undefined)
    let ok = true
    ok = report('roster has the 4 shipped presets',
      SHIPPED_PRESETS.every(id => ids.includes(id)), ids.join(',')) && ok
    ok = report('roster has the 16 provider presets',
      PLUGIN_PRESETS.every(id => ids.includes(id)),
      `missing: ${PLUGIN_PRESETS.filter(id => !ids.includes(id)).join(',') || 'none'}`) && ok
    ok = report('roster has exactly 20 presets', ids.length === 20, `got ${ids.length}`) && ok
    ok = report('no preset is broken', broken.length === 0,
      broken.map(row => `${row.id}: ${row.broken}`).join(' | ') || 'none broken') && ok
    for (const id of ['orchestrator', 'role-cto']) {
      const agent = await composeAgent(ctx, id, id)
      ok = report(`${id} composes an agent with tools`,
        agent.tools.length > 5 && agent.tools.includes('bash'),
        `${agent.tools.length} tools`) && ok
      ok = report(`${id} mounts its own persona`,
        agent.persona.length > 0, agent.persona.slice(0, 60).replace(/\n/g, ' ')) && ok
    }
    const cto = await composeAgent(ctx, 'role-cto', 'cto-persona')
    ok = report('role-cto persona is the CTO specialist',
      cto.persona.includes('You are CTO'), cto.persona.slice(0, 60).replace(/\n/g, ' ')) && ok
    const bootLine = bootLines.join('').split('\n')
      .find(line => line.includes('] registered ') && line.includes('presets from'))
    ok = report('boot line counts the 16 registrations',
      bootLine?.includes('registered 16 presets') ?? false, bootLine?.trim() ?? 'missing') && ok
    const audit = await waitForAudit()
    ok = report('deferred audit reports a clean roster',
      audit?.includes('roster audit: 20 presets in roster, none broken') ?? false,
      audit ?? 'missing') && ok
    return ok ? 0 : 1
  } finally {
    await ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  }
}

async function caseArmed(pluginDir) {
  const home = await mkdtemp(join(tmpdir(), 'roster-e2e-armed-'))
  const fixture = await writeArmedFixture(home)
  const bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app',
    'dsh-multi-agent-harness', 'fixture-missing-inject']
  const ctx = await Promise.race([
    bootWeb(home, [ARMED_PRESET_ROW], [pluginDir, fixture], bundles),
    new Promise((_, reject) => setTimeout(() =>
      reject(new Error('BOOT-HANG')), 90000)),
  ]).catch((error) => {
    if (error.message === 'BOOT-HANG') return null
    throw error
  })
  if (ctx === null) {
    console.log('FAIL armed — host boot hung (roster read inside apply deadlocked the Loader)')
    return 42
  }
  try {
    const rows = await ctx.agentPresets.list()
    const ids = rows.map(row => row.id).sort()
    const armed = rows.find(row => row.id === 'armed')
    let ok = true
    ok = report('boot completed with the deadlock armed', true, 'no hang') && ok
    ok = report('roster still has the 16 provider presets',
      PLUGIN_PRESETS.every(id => ids.includes(id))) && ok
    ok = report('armed preset is reported broken',
      armed?.broken !== undefined, armed?.broken ?? 'not broken') && ok
    ok = report('shipped presets are not collaterally broken',
      SHIPPED_PRESETS.every(id => rows.find(row => row.id === id)?.broken === undefined)) && ok
    const audit = await waitForAudit()
    ok = report('deferred audit names the broken preset',
      audit !== null && audit.includes('broken') && audit.includes('armed'),
      audit ?? 'missing') && ok
    const agent = await composeAgent(ctx, 'orchestrator', 'armed-orchestrator')
    ok = report('orchestrator still composes beside the broken preset',
      agent.tools.includes('bash'), `${agent.tools.length} tools`) && ok
    return ok ? 0 : 1
  } finally {
    await ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  }
}

async function caseIsolate(pluginDir) {
  const home = await mkdtemp(join(tmpdir(), 'roster-e2e-isolate-'))
  const root = await writeIsolateRoot()
  const ctx = await bootWeb(home,
    [{ id: 'dsh-agent-preset-roster', config: { root } }],
    [pluginDir],
    ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-agent-preset-roster'])
  try {
    const rows = await ctx.agentPresets.list()
    const ids = rows.map(row => row.id).sort()
    let ok = true
    ok = report('all three good presets registered',
      ['alpha', 'beta', 'gamma'].every(id => ids.includes(id)), ids.join(',')) && ok
    ok = report('the malformed preset is not in the roster',
      !ids.includes('malformed')) && ok
    ok = report('the composition-less directory is not in the roster',
      !ids.includes('no-composition')) && ok
    ok = report('all good presets compose',
      rows.filter(row => ['alpha', 'beta', 'gamma'].includes(row.id))
        .every(row => row.broken === undefined),
      rows.filter(row => ['alpha', 'beta', 'gamma'].includes(row.id))
        .map(row => `${row.id}:${row.broken ?? 'ok'}`).join(',')) && ok
    const bootText = bootLines.join('')
    ok = report('boot line counts 3 registrations',
      bootText.includes('registered 3 presets from'),
      bootText.split('\n').find(l => l.includes('] registered '))?.trim() ?? 'missing') && ok
    ok = report('malformed preset is logged per-preset',
      bootText.includes('preset malformed failed to register')) && ok
    ok = report('the colliding preset is skipped as a duplicate',
      bootText.includes('skipped 1 already registered'),
      bootText.split('\n').find(l => l.includes('] registered '))?.trim() ?? 'missing') && ok
    const standard = rows.find(row => row.id === 'standard')
    ok = report('the shipped standard preset survives the collision',
      standard !== undefined && standard.broken === undefined) && ok
    const audit = await waitForAudit()
    ok = report('deferred audit runs in the isolate boot too',
      audit !== null, audit ?? 'missing') && ok
    return ok ? 0 : 1
  } finally {
    await ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
}

// ── entry ────────────────────────────────────────────────────────────────

const [caseName, pluginArg] = process.argv.slice(2)
if (!caseName || !pluginArg) {
  console.error('usage: node e2e/roster.e2e.mjs <happy|armed|isolate> <pluginDir>')
  process.exit(2)
}
const pluginDir = isAbsolute(pluginArg) ? pluginArg : join(process.cwd(), pluginArg)
const cases = { happy: caseHappy, armed: caseArmed, isolate: caseIsolate }
const run = cases[caseName]
if (run === undefined) {
  console.error(`unknown case ${caseName}`)
  process.exit(2)
}
run(pluginDir).then((code) => process.exit(code), (error) => {
  console.error(`ERROR ${error?.stack ?? error}`)
  process.exit(1)
})
