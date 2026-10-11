# dsh-agent-preset-roster

Registers the presets deployed under `$DSH_HOME/.agent-presets/` with the
agent-preset registry, so every session can select them in the Web GUI preset
picker.

## Status on this system (2026-10-11)

**Superseded.** The live web profile (`$DSH_HOME/profiles/web`) now wires
`dsh-multi-agent-harness` (`/home/administrator/agent-workspace/dsh-custom/plugins/dsh-multi-agent-harness`),
which registers the same 16 presets (15 `role-*` specialists + `orchestrator`)
directly from its own repository files. There is no `$DSH_HOME/.agent-presets/`
deployment copy any more, so this plugin registers nothing here and is not in
the profile's dependencies or bundles. It remains the reference
implementation of the file-driven pattern and carries the same defect fixes;
new work belongs in the live plugin.

The 2026-10-11 audit that led to the cutover also found two defects in the
roster-registration pattern itself, fixed in both plugins:

1. **Boot deadlock (P0, dormant).** `await presets.list()` inside `apply()`
   re-audits every mounted preset and, while any of them still has a pending
   row, awaits the host Loader (`agent-preset-registry/src/index.ts:135-139`).
   That await waits on the plugin row's own activation, so the deadlock armed
   the moment any listed preset had a row waiting for a service — a silent
   host-boot hang. Both plugins now register without a roster snapshot: the
   registry rejects a duplicate id atomically before any await
   (`src/index.ts:82-85`) and the per-preset catch absorbs it.
2. **Roster rollback on one bad file (P1).** The parse of
   `agent.cordis.yml` ran outside the per-preset try, so a single malformed
   composition escaped `apply`; cordis then ran the already-yielded
   disposers in reverse, unregistering every preset registered before it.
   The parse now sits inside the per-preset guard, matching the live plugin.

## What it does

On `apply`:

1. Resolves the preset root (`$DSH_HOME/.agent-presets`, or `~/.dsh/.agent-presets`
   when `DSH_HOME` is unset; override with the `root` config).
2. Reads each preset directory as a registry definition:
   - `agent.cordis.yml` → the plugin rows, parsed with the Loader's own
     entry-list dialect (`entryListSchema` from `@deepseek-ai/cordis-plugin-include`),
     so `!!js` expressions stay `{ __jsExpr }` nodes for the Loader to evaluate
     at activation, exactly like profile rows.
   - `preset.yml` → the description shown in the picker.
3. Registers each definition through `ctx.agentPresets.register`. There is no
   roster snapshot: a duplicate id is rejected by the registry atomically
   before any await and absorbed by the per-preset catch, so one plugin never
   waits on another plugin's registrations.

Each `register()` disposer is yielded as an effect, so HMR reload or host
teardown unregisters cleanly. A final synthetic disposer clears the deferred
roster audit.

On boot the host log carries two tagged lines:

```
[dsh-agent-preset-roster] registered 3 presets from <root> (skipped 0 already registered, 1 failed)
[dsh-agent-preset-roster] roster audit: 7 presets in roster, none broken
```

The second line is the deferred roster read that makes activation failures
visible: `register()` settles activation without throwing, so the registration
count alone cannot distinguish a usable roster from a fully broken one.

## Install

Not wired into any profile on this system (see Status above). To use it:

- add `dsh-agent-preset-roster` (link to this directory) to the profile's
  `package.json` `dependencies` and `dsh.profile.bundles`;
- deploy preset directories under the resolved root;
- restart the host.

## Verification

`e2e/roster.e2e.mjs` boots the shipped web composition in-process (the same
boot `dsh web` performs, minus the port-binding rows) and asserts the pipeline
end to end. Run from this directory:

```bash
# this plugin over a fixture root: three good presets, one malformed
node e2e/roster.e2e.mjs isolate .
# the live provider plugin (dsh-multi-agent-harness): 20-preset roster,
# unbroken, orchestrator + role-cto compose Agents with tools and persona
node e2e/roster.e2e.mjs happy  <path-to>/dsh-multi-agent-harness
# the deadlock arming scenario: a preset whose composition waits for a
# service no row provides must not hang boot, and the audit must name it
node e2e/roster.e2e.mjs armed  <path-to>/dsh-multi-agent-harness
```

Both defect fixes above are covered by revert-and-run proofs: the `armed` and
`isolate` cases hang, respectively roll the whole roster back, when run against
the pre-fix `index.js`.

## Known limitations

- The deployed `.agent-presets/*` files remain the source of truth; this
  plugin never writes them. A composition referencing a package that no
  longer exists mounts `broken` and is reported by the registry (visible in
  the preset management section, never silently dropped) and counted by the
  deferred roster audit.
- The registry's own logger writes broken-preset warnings to the host log
  stdout stream, not to this plugin's tagged stderr line; the audit line
  quotes the same facts.
- Preset files must use the dialect of the RUNNING harness. Verified defect
  2026-10-10: all 16 deployed presets still used the 0.1.1-rc.2 persona key
  `text:`, which `@deepseek-ai/dsh-persona` on 0.2.0-rc.2 rejects (`prefix`
  is required since harness commit `40792330c0`), so every preset mounted
  broken and could not be selected. Migrating the key to `prefix:` in the 16
  files fixed it; a probe host then read 20 presets, 0 broken.
