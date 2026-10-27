/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 ImKK666. All rights reserved.
 * SPDX-License-Identifier: MIT
 *
 * Terminal-Bench 4.0 (Harbor) held-out runner.
 *
 * TB 4.0 is `terminal-bench/terminal-bench@4.0.0` on the Harbor framework — the
 * Laude `tb` CLI only carries the frozen v0.1.x core, so Harbor is the runner.
 * Harbor's built-in `opencode` agent takes an `opencode_config` overlay: the
 * ONLY difference between the two arms is whether that overlay loads the
 * SoL-OpenCode plugin. Harbor already parses opencode's `step_finish` events
 * into cost and token counts, so we read them back rather than re-deriving.
 *
 * Every invocation is wrapped in the held-out discipline: it will not run
 * without a frozen manifest, and it consumes the one-shot on start.
 *
 * Usage:
 *   node apps/bench/tb/harbor.mjs --freeze <id> --arm treatment [-n 4] [--model m]
 *                                [--only task-a,task-b] [--jobs-dir <path>]
 *
 * `--only` narrows the task list for plumbing work; the ledger entry is stamped
 * `datasetSubset` so a subset can never pass as a full held-out result.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_MODEL } from "../config.mjs";
import { describeCandidate } from "../heldout/candidate.mjs";
import { HeldoutViolation, beginHeldoutRun, loadManifest, recordHeldoutRun } from "../heldout/index.mjs";
import { opencodeConfig } from "./overlay.mjs";
import { parseJob, summarizeTrials } from "./parse.mjs";

const HARBOR = process.env.HARBOR_BIN ?? "harbor";
const DATASET = "terminal-bench/terminal-bench@4.0.0";
const AUTH_PATH = join(homedir(), ".local", "share", "opencode", "auth.json");
const MODELS_PATH = join(homedir(), ".cache", "opencode", "models.json");

function flag(argv, name, fallback) {
	return argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback;
}

function loadCatalogue() {
	return existsSync(MODELS_PATH) ? JSON.parse(readFileSync(MODELS_PATH, "utf8")) : {};
}

/** The provider API key, read from auth.json; never put it in Harbor's argument list. */
function providerApiKey(providerId) {
	if (!existsSync(AUTH_PATH)) return undefined;
	const auth = JSON.parse(readFileSync(AUTH_PATH, "utf8"));
	return auth[providerId]?.key ?? auth[providerId]?.access;
}

function harborEnvironment(value) {
	if (!value) return process.env;
	const environment = { ...process.env };
	environment.OPENCODE_API_KEY = value;
	return environment;
}

function runHarbor({ arm, model, tasks, jobsDir, concurrency, pluginSpec }) {
	const apiKey = providerApiKey(model.split("/")[0]);
	const privateConfigDir = apiKey ? mkdtempSync(join(tmpdir(), "sol-opencode-harbor-")) : undefined;
	const argv = [
		"run",
		"-d",
		DATASET,
		"--agent",
		"opencode",
		"--model",
		model,
		"--ak",
		`opencode_config=${JSON.stringify(opencodeConfig(arm, model, loadCatalogue(), pluginSpec))}`,
		"-o",
		jobsDir,
		"-n",
		String(concurrency),
		"--quiet",
	];
	if (privateConfigDir !== undefined) {
		const configPath = join(privateConfigDir, "job.json");
		writeFileSync(
			configPath,
			JSON.stringify({
				agents: [{ name: "opencode", env: { OPENCODE_API_KEY: "${OPENCODE_API_KEY}" } }],
			}),
			{ encoding: "utf8", mode: 0o600 },
		);
		argv.push("--config", configPath);
	}
	for (const task of tasks) argv.push("--include-task-name", `terminal-bench/${task}`);

	const started = Date.now();
	try {
		const proc = spawnSync(HARBOR, argv, {
			stdio: "inherit",
			env: harborEnvironment(apiKey),
		});
		if (proc.error) throw proc.error;
		return { exitCode: proc.status, wallMs: Date.now() - started };
	} finally {
		if (privateConfigDir !== undefined) rmSync(privateConfigDir, { recursive: true, force: true });
	}
}

const argv = process.argv.slice(2);
const freezeId = flag(argv, "--freeze", null);
const arm = flag(argv, "--arm", "treatment");
const model = flag(argv, "--model", DEFAULT_MODEL);
const concurrency = Number(flag(argv, "-n", "4"));
const only = flag(argv, "--only", null);
// A probe validates infrastructure (image, agent install, model auth). It is NOT
// an evaluation, so it must not touch the held-out ledger or consume the
// one-shot — otherwise an auth check would burn a frozen candidate.
const probe = argv.includes("--probe");

if (!["control", "treatment"].includes(arm) || (!probe && !freezeId) || (probe && !only)) {
	console.error(
		"usage: harbor.mjs --freeze <id> --arm <control|treatment> [-n N] [--model m] [--only a,b]\n" +
			"       harbor.mjs --probe --arm <control|treatment> --only <task>   (infra check, not recorded)",
	);
	process.exit(1);
}

try {
	const manifest = probe ? null : loadManifest(freezeId);
	const tasks = only ? only.split(",") : manifest.split.heldout.tasks;
	const pluginSpec = probe ? describeCandidate().pluginSpec : manifest.candidate.pluginSpec;
	const jobsDir = flag(argv, "--jobs-dir", join(import.meta.dirname, "jobs", freezeId ?? "probe", arm));

	console.log(
		`${probe ? "PROBE (not recorded)" : "held-out run"} ${freezeId ?? ""} arm=${arm} model=${model}\n` +
			`  plugin  ${pluginSpec}\n` +
			`  tasks   ${tasks.length}${only && !probe ? " (subset override — NOT the frozen set)" : ""}\n` +
			`  jobs    ${jobsDir}\n`,
	);

	// Guards fire here: frozen candidate, frozen split, and the one-shot.
	if (!probe) beginHeldoutRun(freezeId, { model });

	const { exitCode, wallMs } = runHarbor({
		arm,
		model,
		tasks,
		jobsDir,
		concurrency,
		pluginSpec,
	});

	const resultDirs = existsSync(jobsDir)
		? readdirSync(jobsDir, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => join(jobsDir, entry.name))
				.sort()
		: [];
	const summary = {
		...summarizeTrials(resultDirs.flatMap(parseJob)),
		arm,
		model,
		dataset: DATASET,
		tasks: tasks.length,
		datasetSubset: only ? true : undefined,
		exitCode,
		wallMs,
	};
	if (!probe) recordHeldoutRun(freezeId, summary);

	console.log(
		`\n  solved ${summary.solved}/${summary.total}  tokens ${summary.tokens}  cost $${summary.cost.toFixed(4)}  ` +
			`errors ${summary.errored}  wall ${(wallMs / 1000).toFixed(0)}s\n` +
			(probe
				? "  probe complete — nothing written to the held-out ledger"
				: "  recorded to ledger; view with: node apps/bench/heldout/cli.mjs report"),
	);
} catch (error) {
	if (error instanceof HeldoutViolation) {
		console.error(`held-out violation: ${error.message}`);
		process.exit(2);
	}
	throw error;
}
