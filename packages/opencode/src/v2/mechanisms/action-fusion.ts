/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 ImKK666. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
	THEN_RUN_FAILED,
	THEN_RUN_SKIPPED,
	THEN_RUN_SUCCEEDED,
	resolveToolPath,
	runThenRun,
	type ThenRunInput,
} from "@alicekk/sol-opencode-core";
import type { V2Kernel } from "../kernel.ts";

const THEN_RUN_ARG = "then_run";

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function thenRun(value: unknown): ThenRunInput | undefined {
	const input = record(value);
	if (typeof input?.command !== "string" || input.command.length === 0) return undefined;
	return typeof input.timeout === "number" && Number.isFinite(input.timeout) && input.timeout > 0
		? { command: input.command, timeout: input.timeout }
		: { command: input.command };
}

function commandResult(result: { stdout: Uint8Array; stderr: Uint8Array; exitCode: number | null }): string {
	const stdout = Buffer.from(result.stdout).toString("utf8");
	const stderr = Buffer.from(result.stderr).toString("utf8");
	const text = [stdout, stderr].filter(Boolean).join("\n");
	if (result.exitCode !== 0) throw new Error(`command exited with code ${result.exitCode}${text ? `\n${text}` : ""}`);
	return text;
}

async function runCommand(kernel: V2Kernel, input: ThenRunInput): Promise<string> {
	const cwd = kernel.ctx.location.directory;
	try {
		const result = await promisify(execFile)("/bin/sh", ["-lc", input.command], {
			cwd,
			encoding: "buffer",
			...(input.timeout === undefined ? {} : { timeout: input.timeout * 1_000 }),
			maxBuffer: 10 * 1024 * 1024,
		});
		return Buffer.concat([result.stdout, result.stderr]).toString("utf8");
	} catch (error) {
		const cause = error as Error & { code?: number; stdout?: Buffer; stderr?: Buffer };
		const output = [cause.stdout?.toString("utf8"), cause.stderr?.toString("utf8")].filter(Boolean).join("\n");
		throw new Error(`${cause.message}${output ? `\n${output}` : ""}`);
	}
}

export async function registerV2ActionFusion(
	kernel: V2Kernel,
	add: (registration: { dispose(): Promise<void> }) => void,
): Promise<void> {
	const toolSet = new Set(kernel.config.actionFusion.tools);
	const pending = new Map<string, { thenRun: ThenRunInput; absolutePath: string }>();
	const definitions = await kernel.ctx.tool.transform((editor) => {
		for (const toolID of toolSet) {
			if (toolID !== "edit" && toolID !== "write") continue;
			const definition = editor.get(toolID);
			if (!definition) continue;
			const input = record(definition.input);
			const properties = record(input?.properties);
			if (!input || !properties) continue;
			editor.update(toolID, (draft) => {
				draft.description = `${definition.description}\n\nThis tool accepts optional then_run: {command, timeout?}; it runs after a successful file mutation.`;
				draft.input = {
				...input,
				properties: {
					...properties,
					[THEN_RUN_ARG]: {
						type: "object",
						properties: {
							command: { type: "string" },
							timeout: { type: "number" },
						},
						required: ["command"],
						additionalProperties: false,
					},
				},
				};
			});
		}
	});
	add(definitions);
	add(await kernel.ctx.tool.hook("execute.before", (event) => {
		if (!toolSet.has(event.tool) || event.id === undefined) return;
		const args = record(event.input);
		if (!args) return;
		const run = thenRun(args[THEN_RUN_ARG]);
		delete args[THEN_RUN_ARG];
		const filePath = typeof args.filePath === "string" ? args.filePath : undefined;
		if (!run || !filePath) return;
		pending.set(String(event.id), { thenRun: run, absolutePath: resolveToolPath(kernel.ctx.location.directory, filePath) });
	}));
	add(await kernel.ctx.tool.hook("execute.after", async (event) => {
		const key = String(event.id);
		const entry = pending.get(key);
		if (!entry) return;
		pending.delete(key);
		if (event.status !== "completed") return;
		const outcome = await runThenRun({
			absolutePath: entry.absolutePath,
			thenRun: entry.thenRun,
			runCommand: (next) => runCommand(kernel, next),
		});
		const result = record(event.result) ?? {};
		const output = typeof result.content === "string" ? result.content : "";
		const marker = outcome.status === "succeeded"
			? `${THEN_RUN_SUCCEEDED}\n${outcome.output}`
			: outcome.status === "failed"
				? `${THEN_RUN_FAILED}\n${outcome.error}`
				: `${THEN_RUN_SKIPPED} ${outcome.reason}`;
		event.result = {
			...result,
			content: `${output}${output ? "\n\n" : ""}${marker}`,
			metadata: { ...record(result.metadata), actionFusion: { status: outcome.status } },
		};
	}));
}
