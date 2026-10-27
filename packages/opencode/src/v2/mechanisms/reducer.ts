/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 ImKK666. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	DIAGNOSTIC_COMMAND,
	REDUCER_RECEIPT_SCHEMA,
	ReceiptCache,
	archiveBody,
	archiveRoot,
	createLedger,
	evaluateReducerGates,
	loadReducerConfig,
	receiptText,
	reducerCacheKey,
	sha256,
	validateReceipt,
	type Ledger,
	type ReducerConfig,
	type ReducerModelResult,
} from "@alicekk/sol-opencode-core";
import type { V2Kernel } from "../kernel.ts";
import { callV2ReducerModel } from "./reducer-transport.ts";

type ObjectMap = Record<string, unknown>;
interface ReducerState { readonly config: ReducerConfig; readonly ledger: Ledger; readonly cache: ReceiptCache }
function object(value: unknown): ObjectMap | undefined { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as ObjectMap : undefined; }
function resultText(result: ObjectMap): string {
	if (typeof result.content === "string") return result.content;
	if (!Array.isArray(result.content)) return "";
	return result.content.flatMap((part) => { const item = object(part); return item?.type === "text" && typeof item.text === "string" ? [item.text] : []; }).join("\n");
}

export async function registerV2Reducer(
	kernel: V2Kernel,
	add: (registration: { dispose(): Promise<void> }) => void,
): Promise<void> {
	const { provider, model } = kernel.config.evidencePreservingReducer;
	const states = new Map<string, ReducerState>();
	const stateFor = (sessionID: string): ReducerState => {
		let state = states.get(sessionID);
		if (!state) {
			const root = kernel.sessionRoot(sessionID);
			const config = loadReducerConfig(root, { ...(provider ? { reducerProvider: provider } : {}), ...(model ? { reducerModel: model } : {}) });
			state = { config, ledger: createLedger(join(root, "evidence-preserving-reducer", "journal.jsonl")), cache: new ReceiptCache(64) };
			states.set(sessionID, state);
		}
		return state;
	};
	add(await kernel.ctx.tool.hook("execute.after", async (event) => {
		if (event.status !== "completed" || event.tool !== "bash" || kernel.isAuxSession(event.sessionID)) return;
		const args = object(event.input);
		const command = typeof args?.command === "string" ? args.command : undefined;
		if (!command || !DIAGNOSTIC_COMMAND.test(command)) return;
		const result = object(event.result) ?? {};
		const metadata = object(result.metadata) ?? {};
		const outputPath = typeof metadata.outputPath === "string" ? metadata.outputPath : undefined;
		let body = resultText(result);
		if (outputPath) { try { body = await readFile(outputPath, "utf8"); } catch { /* retain available text */ } }
		const exit = typeof metadata.exit === "number" ? metadata.exit : 0;
		const isError = exit !== 0;
		const state = stateFor(event.sessionID);
		const gate = evaluateReducerGates(command, body, state.config);
		if (!gate.eligible) return;
		const archive = await archiveBody(archiveRoot(state.config), body);
		const key = reducerCacheKey(state.config, archive.hash, command, isError);
		const cached = state.cache.get(key);
		let modelResult: ReducerModelResult;
		try {
			modelResult = cached ?? await callV2ReducerModel({ kernel, parentSessionID: event.sessionID, provider: state.config.reducerProvider, model: state.config.reducerModel, timeoutMs: state.config.timeoutMs, command, isError, archive, body });
		} catch (error) {
			void state.ledger({ event: "fallback", sourceSha256: archive.hash, reason: error instanceof Error && error.message.includes("timed out") ? "model-call-timeout" : "model-call-exception" });
			return;
		}
		if (!modelResult.ok) return;
		const checked = validateReceipt(modelResult.outputText, archive, body, isError);
		if (!checked.ok) { state.cache.delete(key); void state.ledger({ event: "fallback", sourceSha256: archive.hash, reason: checked.reason }); return; }
		const receipt = receiptText(command, archive, checked.value, modelResult);
		const bytes = Buffer.byteLength(receipt, "utf8");
		if (bytes >= archive.bytes) { state.cache.delete(key); return; }
		if (cached === undefined) state.cache.set(key, modelResult);
		void state.ledger({ event: "applied", commandSha256: sha256(command), sourceSha256: archive.hash, sourceBytes: archive.bytes, receiptBytes: bytes, evidenceCount: checked.value.evidence.length, cacheHit: cached !== undefined });
		event.result = { ...result, content: receipt, metadata: { ...metadata, evidencePreservingReducer: { schema: REDUCER_RECEIPT_SCHEMA, sourceSha256: archive.hash, sourceBytes: archive.bytes, receiptBytes: bytes, evidenceCount: checked.value.evidence.length } } };
	}));
}
