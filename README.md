# dsh-agent-preset-roster

Registers the presets deployed under `$DSH_HOME/.agent-presets/` with the
agent-preset registry, so every session can select them in the Web GUI preset
picker.

## Why

DSH `0.1.1-rc.2` auto-discovered that directory (`includeUserRoot`). The
current harness has no such scan: presets enter the roster only through plugin
contributions (`ctx.agentPresets.register`). Without this plugin the 16
deployed presets (15 `role-*` specialists + the `orchestrator` root-session
preset) sit on disk invisible to the roster.

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
3. Registers each definition through `ctx.agentPresets.register`, skipping ids
   another plugin already registered.

Each `register()` disposer is yielded as an effect, so HMR reload or host
teardown unregisters cleanly.

## Install

Already wired in the web profile (`$DSH_HOME/profiles/web`):

- `package.json` → dependency `dsh-agent-preset-roster` (link to this
  directory) and `dsh.profile.bundles` entry `dsh-agent-preset-roster`.
- This package's own `cordis.patch.yml` inserts the plugin row (bundle
  manifest: `dsh.bundle.patch`).

A host restart applies it. On boot the host log carries one tagged line:

```
[dsh-agent-preset-roster] registered 16 presets from /home/administrator/agent-workspace/.dsh/.agent-presets (4 already registered)
```

## Known limitations

- The deployed `.agent-presets/*` files remain the source of truth; this
  plugin never writes them. A composition referencing a package that no
  longer exists mounts `broken` and is reported by the registry (visible in
  the preset management section, never silently dropped).
- A broken preset is NOT visible in the boot log. The registry records it
  through its own logger, which does not reach stderr, so a boot line
  `registered N presets` is printed even when every preset is broken. The
  only reliable check is the registry's own roster read (`agentPresets.list`
  over RPC, or the preset management section in the GUI).
- Preset files must use the dialect of the RUNNING harness. Verified defect
  2026-10-10: all 16 deployed presets still used the 0.1.1-rc.2 persona key
  `text:`, which `@deepseek-ai/dsh-persona` on 0.2.0-rc.2 rejects (`prefix`
  is required since harness commit `40792330c0`), so every preset mounted
  broken and could not be selected. Migrating the key to `prefix:` in the 16
  files fixed it; a probe host then read 20 presets, 0 broken.
