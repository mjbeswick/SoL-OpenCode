/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 ImKK666. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import type { PluginInput } from "@opencode-ai/plugin";
import { describe, expect, it } from "vitest";
import { SolOpenCodePlugin } from "../src/index.ts";
import SolOpenCodePluginV2 from "../src/v2/index.ts";

function fakeInput(): PluginInput {
	const client = {} as PluginInput["client"];
	const shell = (() => {
		throw new Error("shell is not used during plugin construction");
	}) as unknown as PluginInput["$"];
	return {
		client,
		directory: "/tmp/sol-opencode-test",
		worktree: "/tmp/sol-opencode-test",
		project: {} as PluginInput["project"],
		serverUrl: new URL("http://localhost:4096"),
		$: shell,
	} as unknown as PluginInput;
}

describe("SolOpenCodePlugin wiring", () => {
	it("registers every hook when all mechanisms are enabled", async () => {
		const hooks = await SolOpenCodePlugin(fakeInput(), {
			trajectoryInspector: { enabled: true },
			actionFusion: { enabled: true },
			observationPack: { enabled: true },
			evidencePreservingReducer: { enabled: true },
			onlineContextCompact: { enabled: true },
		});
		const record = hooks as Record<string, unknown>;

		expect(typeof record["event"]).toBe("function");
		expect(typeof record["tool.execute.before"]).toBe("function");
		expect(typeof record["tool.execute.after"]).toBe("function");
		expect(typeof record["tool.definition"]).toBe("function");
		expect(typeof record["experimental.chat.messages.transform"]).toBe("function");
		expect(typeof record["experimental.session.compacting"]).toBe("function");
		expect(Object.keys(record["tool"] as object).sort()).toEqual(["obs_recall", "sol_trajectory"]);
	});

	it("registers nothing when no mechanism is enabled", async () => {
		const hooks = await SolOpenCodePlugin(fakeInput(), {});
		expect(Object.keys(hooks)).toHaveLength(0);
	});
});

describe("SolOpenCodePlugin V2 entrypoint", () => {
	it("exports a stable OpenCode V2 plugin definition", () => {
		expect(SolOpenCodePluginV2.id).toBe("sol-opencode");
		expect(typeof SolOpenCodePluginV2.setup).toBe("function");
	});
});
