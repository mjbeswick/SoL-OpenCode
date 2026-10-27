# @alicekk/sol-opencode

[Project repository](https://github.com/ImKK666/SoL-OpenCode) | **English**

An [OpenCode](https://opencode.ai) plugin that ports the five token-efficiency
mechanisms from NVIDIA's [SoL-Pi](https://github.com/NVlabs/SoL-Pi).

Every mechanism is **opt-in and off by default** — installing the plugin changes
nothing until you enable at least one.

- Repository: <https://github.com/ImKK666/SoL-OpenCode>
- Measured effect: ~61% fewer tokens on a real Terminal-Bench task (N=1; see the
  repo README for the numbers and their limits)

---

## Quick start

**No `npm install` is required.** OpenCode automatically installs npm plugins
with Bun at startup and caches them under `~/.cache/opencode/node_modules/`.

Add the plugin to your OpenCode configuration:

- Per project: `opencode.json` in the project root
- Globally: `~/.config/opencode/opencode.json`

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "compaction": { "auto": false },
  "plugin": [
    ["@alicekk/sol-opencode", {
      "trajectoryInspector": { "enabled": true },
      "actionFusion": { "enabled": true },
      "observationPack": { "enabled": true },
      "evidencePreservingReducer": { "enabled": true },
      "onlineContextCompact": { "enabled": true }
    }]
  ]
}
```

The configuration above enables **all five mechanisms**. Set
`compaction.auto: false` for `onlineContextCompact` to work as intended, then
restart OpenCode.

**All mechanisms are off by default.** Adding only the package name as a string
(`"@alicekk/sol-opencode"`) leaves them disabled. Options go in the **second
element** of the `["package", { … }]` tuple.

For a conservative start, enable only these two mechanisms; neither rewrites
tool output:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["@alicekk/sol-opencode", {
      "trajectoryInspector": { "enabled": true },
      "actionFusion": { "enabled": true }
    }]
  ]
}
```

Verify that the plugin loaded:

```bash
npx -p @alicekk/sol-opencode sol-trajectory sessions
```

If the directory remains empty, the plugin may not have loaded. Check that the
package name is exactly `@alicekk/sol-opencode` and restart OpenCode.

When enabling `onlineContextCompact`, also set
`"compaction": { "auto": false }` to avoid competing with OpenCode's built-in
size-based compaction.

**Privacy:** Trajectory Inspector stores metadata only (no prompts, arguments,
or outputs). The reducer is the only mechanism that sends eligible diagnostic
logs to a model, and it is disabled by default. Archives are stored under
`~/.local/share/sol-opencode` by default.

See the sections below for the complete mechanism descriptions and option
defaults.

---

## Requirements

- OpenCode with plugin support (`@opencode-ai/plugin` ≥ 1.19.4)
- Node.js ≥ 22.19 — only needed for the optional `sol-trajectory` CLI

## Install

**No `npm install` step.** OpenCode installs npm plugins itself with Bun at
startup and caches them under `~/.cache/opencode/`.

Add the plugin to your OpenCode config:

- per project → `opencode.json` in the project root
- global → `~/.config/opencode/opencode.json`

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "compaction": { "auto": false },
  "plugin": [
    ["@alicekk/sol-opencode", {
      "trajectoryInspector": { "enabled": true },
      "actionFusion": { "enabled": true },
      "observationPack": { "enabled": true },
      "evidencePreservingReducer": { "enabled": true },
      "onlineContextCompact": { "enabled": true }
    }]
  ]
}
```

Restart OpenCode. That enables **all five mechanisms**; `compaction.auto: false`
is what lets `onlineContextCompact` work without competing with the built-in
compaction. Options are the **second element** of the `["package", { … }]` tuple,
and a string-only entry (`"@alicekk/sol-opencode"`) loads the plugin with every
mechanism off — the plugin defaults to fully off.

## Enable mechanisms

| Option | Default | What it does |
|---|---|---|
| `trajectoryInspector` | off | Metadata-only JSONL of turns, tools and compactions (`{ enabled, maxRecords }`, default 12). No prompts, arguments or outputs are stored. |
| `actionFusion` | off | `edit`/`write` accept an optional `then_run`; the command runs in the same call (`{ enabled, tools }`, default `["edit","write"]`). |
| `observationPack` | off | Tool results larger than `thresholdBytes` become `obs_<id>` handles with exact paged/literal recall (`{ enabled, thresholdBytes, fullSends }`, defaults 10240 / 2). |
| `evidencePreservingReducer` | off | Long diagnostic logs are reduced to a byte-verified receipt over a child-session model call (`{ enabled, provider?, model? }`). Omit `provider`/`model` to reuse the session's model. |
| `onlineContextCompact` | off | Plan-aware, economic compaction via `session.summarize`, with loop guards (`{ enabled, cacheWriteReadRatio, keepRecentTokens, maxAutoContinuations }`, defaults 12.5 / 20000 / 3). |

### All mechanisms on

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "compaction": { "auto": false },
  "plugin": [
    ["@alicekk/sol-opencode", {
      "trajectoryInspector": { "enabled": true },
      "actionFusion": { "enabled": true },
      "observationPack": { "enabled": true },
      "evidencePreservingReducer": { "enabled": true },
      "onlineContextCompact": { "enabled": true }
    }]
  ]
}
```

> `"compaction": { "auto": false }` is only needed when `onlineContextCompact` is
> on — it stops OpenCode's built-in size-based compaction from competing with it.

### A conservative start

If you would rather not change tool-result handling immediately, this pair is the
lowest-risk entry point (neither one rewrites content):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["@alicekk/sol-opencode", {
      "trajectoryInspector": { "enabled": true },
      "actionFusion": { "enabled": true }
    }]
  ]
}
```

## Verify it loaded

Enable `trajectoryInspector`, then inspect what it recorded:

```bash
npx -p @alicekk/sol-opencode sol-trajectory sessions
```

Events are written under `$SOL_OPENCODE_HOME` (default
`~/.local/share/sol-opencode`). If the directory stays empty, the plugin did not
load — check that the package name is spelled exactly `@alicekk/sol-opencode`
and that you restarted OpenCode.

You can also ask the running agent to dump recent records with the bundled
`sol_trajectory` tool.

## CLI

```bash
npx -p @alicekk/sol-opencode sol-trajectory sessions [project-slug]   # list sessions
npx -p @alicekk/sol-opencode sol-trajectory show <session-path>       # print events
npx -p @alicekk/sol-opencode sol-trajectory tail <session-path>       # follow events
```

## Data, privacy and security

- Archives and metadata go under `$SOL_OPENCODE_HOME` (default
  `~/.local/share/sol-opencode`), per project and session.
- The **trajectory inspector stores no prompts, arguments or outputs** — only
  metadata (turn/tool/compaction shape).
- The **reducer is the only mechanism that sends content to a model** (eligible
  diagnostic logs, via a child session), and it is off by default.
- Everything else runs locally.

See `SECURITY.md` in the repository for the full data-flow description.

## Community

This project acknowledges and links to the [LINUX DO](https://linux.do) community.

## License

MIT. Ported mechanisms retain their upstream NVIDIA SPDX headers; see
`THIRD_PARTY_NOTICES.md` in the repository.
