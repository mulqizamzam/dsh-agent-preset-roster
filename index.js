// dsh-agent-preset-roster — file-driven preset registration
//
// The 0.2.0-rc.2 harness has no `.agent-presets` directory discovery (the
// 0.1.1-rc.2 `includeUserRoot` scan is gone), so the 16 presets deployed
// under `$DSH_HOME/.agent-presets/` (15 roles + the orchestrator root-session
// preset) are invisible to the roster and cannot be selected in the Web GUI.
// This plugin reads that directory and registers every preset it finds with
// the agent-preset registry.
//
// Contract:
//   - The deployed files stay the source of truth. This plugin reads them at
//     apply time; it never rewrites them.
//   - `agent.cordis.yml` is parsed with the Loader's own entry-list dialect
//     (`entryListSchema` from cordis-plugin-include), so `!!js` expressions
//     survive as `{ __jsExpr }` nodes and are evaluated by the Loader at
//     activation, exactly as profile rows are.
//   - `preset.yml` contributes the description only (display metadata).
//   - Registration is a generator effect: each `register()` disposer is
//     yielded, so HMR or host teardown unregisters cleanly.
//   - A preset whose composition fails to activate is recorded `broken` by
//     the registry and stays visible in the management section; it never
//     throws here, so one bad preset cannot take the host down.
//   - Boot diagnostics use a tagged stderr line, the same channel the host
//     captures for other plugins' boot lines.

import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

import Schema from '@deepseek-ai/schemastery'
import yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

export const name = 'dsh-agent-preset-roster'
export const inject = ['agentPresets']

export const Config = Schema.object({
  /** Preset root to read; empty resolves to the DSH user preset root. */
  root: Schema.string().default(''),
})

const TAG = '[dsh-agent-preset-roster]'
const COMPOSITION_FILE = 'agent.cordis.yml'
const METADATA_FILE = 'preset.yml'

/** One tagged line to stderr, the host's boot-log channel. */
function log(message) {
  process.stderr.write(`${TAG} ${message}\n`)
}

/** The user preset root: `$DSH_HOME/.agent-presets`, overridable by config. */
function resolveRoot(configured) {
  if (configured) return path.resolve(configured)
  const dshHome = process.env.DSH_HOME?.trim()
  if (dshHome) return path.join(dshHome, '.agent-presets')
  return path.join(homedir(), '.dsh', '.agent-presets')
}

/** Read one preset directory into a registry definition, or null to skip. */
async function readPreset(id, dir) {
  const compositionPath = path.join(dir, COMPOSITION_FILE)
  if (!existsSync(compositionPath)) return null
  const composition = await readFile(compositionPath, 'utf8')
  const plugins = yaml.load(composition, { schema: entryListSchema })
  const definition = { id, plugins }
  const metadataPath = path.join(dir, METADATA_FILE)
  if (existsSync(metadataPath)) {
    const metadata = (yaml.load(await readFile(metadataPath, 'utf8'))) ?? {}
    if (typeof metadata.description === 'string' && metadata.description) {
      definition.description = metadata.description
    }
  }
  return definition
}

export async function* apply(ctx, config) {
  const root = resolveRoot(config?.root ?? '')
  if (!existsSync(root)) {
    log(`preset root ${root} does not exist; registering nothing`)
    return
  }
  const presets = ctx.agentPresets
  // Never collide with a preset another plugin already registered under the
  // same id: the registry rejects duplicates and would fail this plugin.
  const existing = new Set((await presets.list()).map((row) => row.id))
  const entries = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  let registered = 0
  for (const id of entries) {
    if (existing.has(id)) continue
    const definition = await readPreset(id, path.join(root, id))
    if (definition === null) continue
    try {
      // register() resolves only after activation settles; a broken
      // composition is recorded on the row, not thrown, so the loop
      // continues. A throw here is a definition-level fault (e.g. an empty
      // id) and must not take the host down.
      yield await presets.register(definition)
      registered += 1
    } catch (error) {
      log(`preset ${id} failed to register: ${String(error)}`)
    }
  }
  log(`registered ${registered} presets from ${root} ` +
      `(${existing.size} already registered)`)
}
