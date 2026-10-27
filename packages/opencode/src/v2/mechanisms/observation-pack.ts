/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 ImKK666. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	createLedger,
	createObservation,
	ensureStored,
	isObservationId,
	observationPath,
	placeholderFor,
	readRecallChunk,
	searchObservation,
	type Ledger,
	type SearchResult,
} from "@alicekk/sol-opencode-core";
import type { V2Kernel } from "../kernel.ts";

const RECALL_MAX_BYTES = 16 * 1024;
const RECALL_MAX_LINES = 400;
const MAX_QUERY_BYTES = 256;
const OWN_TOOLS = new Set(["obs_recall", "sol_trajectory"]);
type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : undefined;
}

function resultText(value: unknown): string {
	const result = object(value);
	if (!result) return "";
	if (typeof result.content === "string") return result.content;
	if (!Array.isArray(result.content)) return "";
	return result.content.flatMap((part) => {
		const item = object(part);
		return item?.type === "text" && typeof item.text === "string" ? [item.text] : [];
	}).join("\n");
}

function formatSearch(result: SearchResult): string {
	if (result.matches.length === 0) return `No matches (eof=${result.eof}, next_offset=${result.nextOffset}).`;
	return `${result.matches.map((match) => `#${match.line} @${match.byteOffset}: ${match.context}`).join("\n---\n")}\n[next_offset=${result.nextOffset} eof=${result.eof}]`;
}

export async function registerV2ObservationPack(
	kernel: V2Kernel,
	add: (registration: { dispose(): Promise<void> }) => void,
): Promise<void> {
	const { thresholdBytes, fullSends } = kernel.config.observationPack;
	const ledgers = new Map<string, Ledger>();
	const ledgerFor = (sessionID: string): Ledger => {
		let ledger = ledgers.get(sessionID);
		if (!ledger) {
			ledger = createLedger(join(kernel.sessionRoot(sessionID), "observation-pack", "ledger.jsonl"));
			ledgers.set(sessionID, ledger);
		}
		return ledger;
	};
	add(await kernel.ctx.tool.hook("execute.after", async (event) => {
		if (event.status !== "completed" || event.sessionID === undefined || kernel.isAuxSession(event.sessionID) || OWN_TOOLS.has(event.tool)) return;
		const result = object(event.result);
		const text = resultText(event.result);
		if (!text) return;
		const metadata = object(result?.metadata) ?? {};
		const outputPath = typeof metadata.outputPath === "string" ? metadata.outputPath : undefined;
		let body = text;
		if (outputPath) {
			try { body = await readFile(outputPath, "utf8"); } catch { /* use structured output */ }
		}
		const observation = createObservation({ toolName: event.tool, toolCallId: String(event.id), text: body }, kernel.sessionRoot(event.sessionID), thresholdBytes);
		if (!observation) return;
		await ensureStored(observation);
		(event as unknown as { result: unknown }).result = {
			...result,
			content: placeholderFor(observation),
			metadata: {
				...metadata,
				observationPack: { id: observation.id, bytes: observation.bytes, lines: observation.lines, tokens: observation.tokens, tool: observation.toolName, placeholder: placeholderFor(observation) },
			},
		};
	}));
	add(await kernel.ctx.session.hook("context", (event) => {
		if (kernel.isAuxSession(event.sessionID)) return;
		const assistantMessagesAfter = (index: number): number => event.messages.slice(index + 1).filter((message) => message.role === "assistant").length;
		for (let index = 0; index < event.messages.length; index++) {
			const message = event.messages[index];
			if (!message || assistantMessagesAfter(index) < fullSends) continue;
			for (const part of message.content) {
				if (part.type !== "tool-result") continue;
				const metadata = object(part.metadata);
				const observation = object(metadata?.observationPack);
				if (!observation || typeof observation.id !== "string" || !isObservationId(observation.id) || typeof observation.placeholder !== "string") continue;
				if (part.result.type === "text" && part.result.value === observation.placeholder) continue;
				(part as unknown as { result: unknown }).result = { type: "text", value: observation.placeholder };
				void ledgerFor(event.sessionID)({ event: "placeholder", id: observation.id, bytes: observation.bytes, tokens: observation.tokens });
			}
		}
	}));
	const registration = await kernel.ctx.tool.transform((editor) => {
		editor.add({
			name: "obs_recall",
			description: "Recall an archived tool result by page or case-sensitive literal byte search.",
			input: { type: "object", properties: { id: { type: "string" }, offset: { type: "number" }, query: { type: "string" } }, required: ["id"], additionalProperties: false } as never,
			execute: async (rawInput, context) => {
				const input = rawInput as { id: string; offset?: number; query?: string };
				if (!isObservationId(input.id)) return { content: "Invalid observation id." };
				const path = observationPath(kernel.sessionRoot(context.sessionID), input.id);
				const ledger = ledgerFor(context.sessionID);
				const query = typeof input.query === "string" && input.query.length ? input.query : undefined;
				const offset = typeof input.offset === "number" && Number.isSafeInteger(input.offset) && input.offset >= 0 ? input.offset : 0;
				try {
					if (query !== undefined) {
						const bytes = Buffer.from(query, "utf8");
						if (bytes.length > MAX_QUERY_BYTES) return { content: `Query must be at most ${MAX_QUERY_BYTES} UTF-8 bytes.` };
						const result = await searchObservation(path, bytes, offset, RECALL_MAX_BYTES, context.signal);
						void ledger({ event: "search", id: input.id, offset, matches: result.matches.length, eof: result.eof });
						return { content: formatSearch(result) };
					}
					const chunk = await readRecallChunk(path, offset, { maxBytes: RECALL_MAX_BYTES, maxLines: RECALL_MAX_LINES });
					void ledger({ event: "recall", id: input.id, offset, nextOffset: chunk.nextOffset, eof: chunk.eof });
					return { content: `${chunk.text}\n[next_offset=${chunk.nextOffset} eof=${chunk.eof}]` };
				} catch (error) {
					return { content: `obs_recall failed: ${error instanceof Error ? error.message : String(error)}` };
				}
			},
		});
	});
	add(registration);
}
