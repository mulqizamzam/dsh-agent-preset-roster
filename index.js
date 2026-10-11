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
//   - No roster snapshot is read at apply time. `agentPresets.list()`
//     re-audits every mounted preset and, while any of them still has a
//     pending row, awaits the host Loader (agent-preset-registry
//     src/index.ts:135-139) — and that await waits on THIS row's own
//     activation, so calling it from `apply` would hang host boot the moment
//     any listed preset has a pending row. The registry rejects a duplicate
//     id atomically before any await (src/index.ts:82-85), and the per-preset
//     catch below absorbs that rejection, so no snapshot is needed.
//   - Boot diagnostics use a tagged stderr line, the same channel the host
//     captures for other plugins' boot lines.
//   - Boot diagnostics are honest: registration success is not activation
//     success, so one deferred roster read (scheduled, never awaited — see
//     the audit note in `apply`) reports how many presets are `broken`.

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

/** Register one preset under `id` from `dir`.
 *
 * Returns `{ dispose, reason }`:
 *   - `{ dispose, 'registered' }` — the registry accepted the definition and
 *     activation settled; the caller yields `dispose`.
 *   - `{ null, 'duplicate' }` — another plugin already owns the id. The
 *     registry throws before any await, so this is decided atomically.
 *   - `{ null, 'absent' }` — the directory holds no composition file.
 *   - `{ null, 'failed' }` — parse or registration fault, logged per preset.
 *
 * The parse lives inside the try on purpose: an unreadable or malformed
 * `agent.cordis.yml` used to escape `apply`, which rolled back every preset
 * registered before it. An activation failure is NOT a failure here: the
 * registry records it `broken` on the row and still returns the disposer, so
 * the preset stays visible in the roster and the deferred audit reports it.
 */
async function tryRegister(presets, id, dir) {
  try {
    const definition = await readPreset(id, dir)
    if (definition === null) return { dispose: null, reason: 'absent' }
    const dispose = await presets.register(definition)
    return { dispose, reason: 'registered' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.startsWith('Duplicate agent preset')) {
      return { dispose: null, reason: 'duplicate' }
    }
    log(`preset ${id} failed to register: ${message}`)
    return { dispose: null, reason: 'failed' }
  }
}

export async function* apply(ctx, config) {
  const root = resolveRoot(config?.root ?? '')
  if (!existsSync(root)) {
    log(`preset root ${root} does not exist; registering nothing`)
    return
  }
  const presets = ctx.agentPresets
  let registered = 0
  let skipped = 0
  let failed = 0
  let entries = []
  try {
    entries = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch (error) {
    log(`preset root ${root} unreadable: ${String(error)}`)
    return
  }
  for (const id of entries) {
    const outcome = await tryRegister(presets, id, path.join(root, id))
    if (outcome.reason === 'registered') {
      yield outcome.dispose
      registered += 1
    } else if (outcome.reason === 'duplicate') skipped += 1
    else if (outcome.reason === 'failed') failed += 1
  }
  log(`registered ${registered} presets from ${root} ` +
      `(skipped ${skipped} already registered, ${failed} failed)`)

  // Boot-log honesty. `register()` settles activation without throwing, so
  // the count above includes presets the registry recorded `broken`; the
  // registry warns through its own logger, which this tagged line cannot
  // see. One deferred roster read reports the activation outcomes. It is
  // scheduled and never awaited: this row's activation settles first, so the
  // registry's host-Loader await inside `list()` can no longer wait on this
  // row — reading the roster from inside `apply` is the boot deadlock the
  // snapshot removal above avoids.
  const audit = setTimeout(() => {
    presets.list().then((rows) => {
      const broken = rows.filter((row) => row.broken !== undefined)
      const summary = broken.length === 0
        ? `${rows.length} presets in roster, none broken`
        : `${rows.length} presets in roster, ${broken.length} broken — ` +
          broken.map((row) => `${row.id}: ${row.broken}`).join(' | ')
      log(`roster audit: ${summary}`)
    }, (error) => {
      log(`roster audit failed: ${String(error)}`)
    })
  }, 0)
  // Yielded last, so teardown clears the timer before the disposers that
  // unregister the presets it would read.
  yield () => clearTimeout(audit)
}
