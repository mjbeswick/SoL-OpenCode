# SoL-OpenCode

**Spend less context on repeated tool output. Keep the source evidence.**

SoL-OpenCode is an OpenCode plugin that adapts context- and tool-efficiency
ideas from NVIDIA's [SoL-Pi](https://github.com/NVlabs/SoL-Pi). It is designed
to reduce repeated tokens and unnecessary model turns while keeping original
tool output available for inspection.

> **Every feature is disabled by default.** Installing the plugin alone does
> not change model requests, tool output, or data sent to a model.

This repository is an English-language copy of the original
[ImKK666/SoL-OpenCode](https://github.com/ImKK666/SoL-OpenCode) project.

## Why use it?

Coding agents often resend large command results and spend separate turns
editing files and checking the result. SoL-OpenCode offers opt-in mechanisms to
reduce those costs:

| Mechanism | Potential benefit | Trade-off |
|---|---|---|
| **ObservationPack** | Replaces repeatedly replayed large tool results with a compact reference; retrieve exact archived text by page or search. | Adds a local archive and a recall tool. |
| **Action Fusion** | Runs a validation command after an `edit` or `write` in the same tool call, which can save a model turn. | The follow-up command runs with the agent's local shell permissions. |
| **Evidence-Preserving Reducer** | Turns eligible long diagnostic logs into a smaller receipt with quotations checked against the original archive. | Makes an additional model call and sends eligible logs to the configured provider. Disabled by default. |
| **Online Context Compact** | Requests compaction at an intentional plan boundary instead of relying only on context size. | OpenCode V2 has no automatic-continuation hook; the V2 adapter does not add a continuation prompt. |
| **Trajectory Inspector** | Records lightweight session and tool metadata to help understand agent behavior. | Writes local metadata files; it does not store prompts or tool output. |

Each mechanism is opt-in and can be enabled independently. The reducer is the
only feature that sends diagnostic-log content in an additional model request.
Read [`SECURITY.md`](./SECURITY.md) before enabling it.

## What savings were measured?

The project benchmarks are useful evidence, **not a promise of savings for your
workload**:

- In one real-model coding task, the median of five runs reported **50.3% fewer
  total tokens** and **43.6% lower cost** with the plugin enabled. Both arms
  completed the task, but wall time rose from 10.4 to 24.5 seconds (**+136%**),
  partly because the reducer made an extra model call.
- In one Terminal-Bench 4.0 paired probe (**one task, one run per arm**), input
  tokens were **61.3% lower** and cost **33.9% lower**. Neither arm solved the
  task, so this probe does **not** establish that capability was preserved.
- Deterministic mock-provider tests measured less repeated tool output for
  ObservationPack and fewer turns for Action Fusion in their scripted scenarios.

Savings depend on the tasks, model, provider pricing, and which features you
enable. The benchmarks are small and not like-for-like with the upstream SoL-Pi
results. See [the full benchmark report](./apps/bench/README.md) and
[Terminal-Bench details](./apps/bench/tb/README.md) for methods and limitations.

## OpenCode compatibility

- **OpenCode V2 (2.1.4+):** the default package entrypoint uses the V2 plugin
  API. Online Context Compact uses explicit plan-boundary markers because V2
  does not expose the V1 todo-update hook. A prompt can declare a boundary by
  including one of the configured keywords (default: `milestone complete`,
  `phase complete`, or `implementation complete`) and a JSON array of remaining
  plan items. V2 compaction does not automatically send a follow-up prompt.
- **OpenCode V1 (1.18.30+):** the legacy adapter is available as
  `@alicekk/sol-opencode/v1`.

## Install

Add the plugin to your OpenCode V2 global config at
`~/.config/opencode/opencode.json` or `.jsonc`, or to the current project's
`opencode.json` / `.opencode/opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "@alicekk/sol-opencode",
      "options": {}
    }
  ]
}
```

With empty options, **all features remain off**. To enable a feature, set its
`enabled` flag in the options object. For example, to start with metadata-only
trajectory records and same-call follow-up checks:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "@alicekk/sol-opencode",
      "options": {
        "trajectoryInspector": { "enabled": true },
        "actionFusion": { "enabled": true }
      }
    }
  ]
}
```

The above is a conservative starting point: it does not rewrite tool output or
send additional content to a model. For local development, use the absolute
path to `packages/opencode` as the `package` value. OpenCode watches config
changes; use `/reload` if needed.

Full option descriptions and defaults are in
[`packages/opencode/README.md`](./packages/opencode/README.md).

## Project layout

```text
packages/core/       Framework-independent mechanisms and unit tests
packages/opencode/   OpenCode V1 and V2 plugin adapters
apps/e2e/            Deterministic mock and real-model A/B harnesses
apps/bench/          Development and held-out benchmark tooling
```

## Development

Requirements: Node.js 22.19+ and [Bun](https://bun.sh).

```bash
bun install
bun run check       # TypeScript typecheck and unit tests
bun run e2e:all     # Deterministic mock-provider A/B scenarios
bun run bench       # Development benchmark suite
```

## License and attribution

MIT. This English-language copy references the original
[ImKK666/SoL-OpenCode](https://github.com/ImKK666/SoL-OpenCode) project.
Ported core files retain NVIDIA's upstream SPDX notices; see
[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).
