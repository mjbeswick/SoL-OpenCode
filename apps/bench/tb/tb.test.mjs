/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 ImKK666. All rights reserved.
 * SPDX-License-Identifier: MIT
 *
 * Pins the two things that would silently corrupt a held-out result: the arm
 * overlay (the only difference between control and treatment) and the parse of
 * Harbor's result schema.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { opencodeConfig, providerBlock } from "./overlay.mjs";
import { parseTrial, summarizeTrials } from "./parse.mjs";

const CATALOGUE = { "opencode-go": { npm: "@ai-sdk/openai-compatible", api: "https://opencode.ai/zen/go/v1" } };
const MODEL = "opencode-go/deepseek-v4.1-flash";
const SPEC = "@alicekk/sol-opencode@0.1.0";
const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

describe("opencodeConfig", () => {
	it("gives the control arm the provider but no plugin", () => {
		const config = opencodeConfig("control", MODEL, CATALOGUE, SPEC);
		expect(config.plugin).toBeUndefined();
		expect(config.provider["opencode-go"].options.baseURL).toBe("https://opencode.ai/zen/go/v1");
		expect(config.provider["opencode-go"].npm).toBe("@ai-sdk/openai-compatible");
	});

	it("gives the treatment arm the pinned plugin with all five mechanisms", () => {
		const config = opencodeConfig("treatment", MODEL, CATALOGUE, SPEC);
		expect(config.plugin[0][0]).toBe(SPEC);
		expect(Object.keys(config.plugin[0][1])).toHaveLength(5);
		expect(config.provider["opencode-go"].models["deepseek-v4.1-flash"]).toEqual({});
	});

	it("refuses a treatment arm with no pinned plugin spec", () => {
		expect(() => opencodeConfig("treatment", MODEL, CATALOGUE)).toThrow(/frozen plugin spec/);
	});

	it("rejects a model id with no provider", () => {
		expect(() => providerBlock("nope", CATALOGUE)).toThrow(/provider\/model/);
	});
});

describe("parseTrial", () => {
	it("reads the real Harbor trial schema", () => {
		const trial = parseTrial({
			task_name: "terminal-bench/html-js-filter",
			agent_result: { n_input_tokens: 1000, n_output_tokens: 200, cost_usd: 0.02 },
			verifier_result: { rewards: { reward: 1.0 } },
			exception_info: null,
		});
		expect(trial).toEqual({ task: "html-js-filter", solved: true, errored: false, tokens: 1200, cost: 0.02 });
	});

	it("treats a missing reward as unsolved and a missing agent_result as zero cost", () => {
		const trial = parseTrial({
			task_name: "terminal-bench/x",
			agent_result: null,
			verifier_result: null,
			exception_info: "boom",
		});
		expect(trial.solved).toBe(false);
		expect(trial.tokens).toBe(0);
		expect(trial.cost).toBe(0);
		expect(trial.errored).toBe(true);
	});

	it("summarizes a run", () => {
		const summary = summarizeTrials([
			{ solved: true, errored: false, tokens: 10, cost: 0.1 },
			{ solved: false, errored: false, tokens: 5, cost: 0.05 },
		]);
		expect(summary).toEqual({ total: 2, solved: 1, errored: 0, tokens: 15, cost: 0.15 });
	});
});

describe("Harbor API key handling", () => {
	it("passes the key through the child environment, not argv or the temporary config", () => {
		const temporaryRoot = mkdtempSync(join(tmpdir(), "sol-harbor-security-"));
		const fakeHarbor = join(temporaryRoot, "fake-harbor.cjs");
		const authPath = join(temporaryRoot, ".local", "share", "opencode", "auth.json");
		const resultPath = join(temporaryRoot, "captured.json");
		const secret = ["harbor", "test", "value"].join("-");
		mkdirSync(dirname(authPath), { recursive: true });
		writeFileSync(authPath, JSON.stringify({ "opencode-go": { key: secret } }), "utf8");
		writeFileSync(
			fakeHarbor,
			`#!/usr/bin/env node\n` +
				`const { readFileSync, statSync, writeFileSync } = require("node:fs");\n` +
				`const args = process.argv.slice(2);\n` +
				`const configPath = args[args.indexOf("--config") + 1];\n` +
				`const config = JSON.parse(readFileSync(configPath, "utf8"));\n` +
				`writeFileSync(process.env.TEST_RESULT_PATH, JSON.stringify({\n` +
				`  keyAvailableInEnv: process.env.OPENCODE_API_KEY === ${JSON.stringify(secret)},\n` +
				`  keyPresentInArgs: args.some((arg) => arg.includes(${JSON.stringify(secret)})),\n` +
				`  configEnv: config.agents[0].env.OPENCODE_API_KEY,\n` +
				`  configMode: statSync(configPath).mode & 0o777,\n` +
				`  configDirectory: require("node:path").dirname(configPath),\n` +
				`}));\n`,
			{ encoding: "utf8", mode: 0o700 },
		);
		chmodSync(fakeHarbor, 0o700);

		try {
			const run = spawnSync(
				process.execPath,
				[
					join(REPOSITORY_ROOT, "apps/bench/tb/harbor.mjs"),
					"--probe",
					"--arm",
					"control",
					"--only",
					"html-js-filter",
					"--jobs-dir",
					join(temporaryRoot, "jobs"),
				],
				{
					cwd: REPOSITORY_ROOT,
					env: {
						...process.env,
						HOME: temporaryRoot,
						HARBOR_BIN: fakeHarbor,
						TEST_RESULT_PATH: resultPath,
					},
					encoding: "utf8",
				},
			);
			expect(run.status, run.stderr).toBe(0);
			const result = JSON.parse(readFileSync(resultPath, "utf8"));
			expect(result.keyAvailableInEnv).toBe(true);
			expect(result.keyPresentInArgs).toBe(false);
			expect(result.configEnv).toBe("${OPENCODE_API_KEY}");
			expect(result.configMode).toBe(0o600);
			expect(existsSync(result.configDirectory)).toBe(false);
		} finally {
			rmSync(temporaryRoot, { recursive: true, force: true });
		}
	});
});
