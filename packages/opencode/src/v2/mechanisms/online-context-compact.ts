/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 ImKK666. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import { constants } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DEFAULT_COMPACTION_ECONOMICS, decideCompaction, estimateTokens, parsePlanSteps, type PlanStep } from "@alicekk/sol-opencode-core";
import type { V2Kernel } from "../kernel.ts";

const MEMO_TOKENS = 1_000;
const MAX_HISTORY = 20;
interface State {
	plan: readonly PlanStep[];
	pendingBoundary: boolean;
	contextTokens: number;
	previousTokens: number;
	increments: number[];
	boundaryRequests: number[];
	boundaryStart: number;
	requestCount: number;
	priorCompactionCount: number;
	autoContinuations: number;
	inFlight: boolean;
	providerID?: string;
	modelID?: string;
}
type ObjectMap = Record<string, unknown>;
function object(value: unknown): ObjectMap | undefined { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as ObjectMap : undefined; }
function initial(): State { return { plan: [], pendingBoundary: false, contextTokens: 0, previousTokens: 0, increments: [], boundaryRequests: [], boundaryStart: 0, requestCount: 0, priorCompactionCount: 0, autoContinuations: 0, inFlight: false }; }
function parseBoundary(text: string, keywords: readonly string[]): readonly PlanStep[] | undefined {
	const trimmed = text.trim();
	if (!keywords.some((keyword) => trimmed.toLowerCase().includes(keyword.toLowerCase()))) return undefined;
	const body = trimmed.replace(/^\s*```(?:json)?\s*/iu, "").replace(/\s*```\s*$/u, "");
	try {
		const value: unknown = JSON.parse(body);
		if (!Array.isArray(value)) return undefined;
		const steps: PlanStep[] = value.flatMap((item) => {
			const todo = object(item);
			if (typeof todo?.content !== "string" || typeof todo.id !== "string") return [];
			const status = todo.status === "completed" || todo.status === "in_progress" ? todo.status : "pending";
			return status === "completed" ? [] : [{ id: todo.id, goal: todo.content, status }];
		});
		return parsePlanSteps(steps);
	} catch { return undefined; }
}

export async function registerV2OnlineContextCompact(
	kernel: V2Kernel,
	add: (registration: { dispose(): Promise<void> }) => void,
): Promise<void> {
	const options = kernel.config.onlineContextCompact;
	const states = new Map<string, State>();
	const stateFor = (id: string): State => { let state = states.get(id); if (!state) { state = initial(); states.set(id, state); } return state; };
	const persist = (sessionID: string, state: State): void => {
		const root = kernel.sessionRoot(sessionID);
		const projectRoot = dirname(root);
		const dataRoot = dirname(projectRoot);
		const directory = join(root, "online-context-compact");
		const path = join(directory, "state.json");
		const payload = JSON.stringify({ schema: "sol_opencode_online_context_compact/v2", plan: state.plan, pendingBoundary: state.pendingBoundary, contextTokens: state.contextTokens, boundaryRequests: state.boundaryRequests, priorCompactionCount: state.priorCompactionCount, autoContinuations: state.autoContinuations, providerID: state.providerID, modelID: state.modelID });
		const secureDir = async (current: string): Promise<void> => { await mkdir(current, { recursive: true, mode: 0o700 }); const stats = await lstat(current); if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("state path must be a real directory"); await chmod(current, 0o700); };
		void secureDir(dataRoot).then(() => secureDir(projectRoot)).then(() => secureDir(root)).then(() => secureDir(directory)).then(async () => {
			const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
			try { await handle.chmod(0o600); await handle.writeFile(payload, "utf8"); } finally { await handle.close(); }
		}).catch((error) => kernel.log(`online-context-compact state write failed: ${String(error)}`));
	};
	const summarize = async (sessionID: string, state: State): Promise<void> => {
		if (!state.pendingBoundary || state.inFlight || state.autoContinuations >= options.maxAutoContinuations || !state.providerID || !state.modelID) return;
		const averageIncrement = state.increments.length ? state.increments.reduce((sum, value) => sum + value, 0) / state.increments.length : null;
		const decision = decideCompaction({ writeTokens: state.contextTokens, archiveTokens: Math.max(0, state.contextTokens - options.keepRecentTokens), memoTokens: MEMO_TOKENS, contextTokens: state.contextTokens, completedBoundaryRequestCounts: state.boundaryRequests.length ? [...state.boundaryRequests] : null, remainingBoundaries: state.plan.length, averageContextTokenIncrement: averageIncrement, contextWindowTokens: null, priorCompactionCount: state.priorCompactionCount, carriedDebtTokens: 0, cacheDebtRepaymentTokens: 0, cacheWriteReadRatio: options.cacheWriteReadRatio, economics: DEFAULT_COMPACTION_ECONOMICS });
		if (!decision.compact) return;
		state.inFlight = true;
		try {
			await kernel.ctx.session.compact({ sessionID, delivery: "steer" });
			state.pendingBoundary = false;
			state.autoContinuations += 1;
		} catch (error) { kernel.log(`online-context-compact compact failed: ${String(error)}`); }
		finally { state.inFlight = false; persist(sessionID, state); }
	};
	const context = await kernel.ctx.session.hook("context", (event) => {
		if (kernel.isAuxSession(event.sessionID)) return;
		const tokens = event.messages.reduce((sum, message) => sum + message.content.reduce((partTotal, part) => partTotal + (part.type === "text" ? estimateTokens(part.text) : part.type === "tool-result" ? estimateTokens(String(part.result.value ?? "")) : 0), 0), 0);
		const state = stateFor(event.sessionID);
		const increment = tokens - state.previousTokens;
		if (increment > 0) state.increments.push(increment);
		if (state.increments.length > MAX_HISTORY) state.increments.shift();
		state.requestCount += 1;
		state.previousTokens = tokens;
		state.contextTokens = tokens;
		if (event.model.providerID) state.providerID = event.model.providerID;
		if (event.model.id) state.modelID = event.model.id;
	});
	add(context);
	add(await kernel.ctx.session.hook("context", (event) => {
		if (!kernel.isAuxSession(event.sessionID) && stateFor(event.sessionID).pendingBoundary) {
			event.system.push({ type: "text", text: `A plan boundary has been reached. Preserve completed work, verification results, important decisions, and remaining work. Remaining plan: ${JSON.stringify(stateFor(event.sessionID).plan)}` });
		}
	}));
	add(await kernel.ctx.session.hook("compaction", (event) => {
		if (!kernel.isAuxSession(event.sessionID)) event.system.push({ type: "text", text: "Preserve completed work, verification results, important decisions, and remaining work." });
	}));
	add(await kernel.ctx.session.hook("prompt", (event) => {
		const parsed = parseBoundary(event.prompt.text, options.boundaryKeywords);
		if (!parsed) return;
		const state = stateFor(event.sessionID);
		state.plan = parsed;
		state.pendingBoundary = true;
		state.boundaryRequests.push(Math.max(1, state.requestCount - state.boundaryStart));
		if (state.boundaryRequests.length > 12) state.boundaryRequests.shift();
		state.boundaryStart = state.requestCount;
		persist(event.sessionID, state);
	}));
	const controller = new AbortController();
	add({ dispose: async () => controller.abort() });
	void (async () => {
		for await (const event of kernel.ctx.event.subscribe({ signal: controller.signal })) {
			if (event.type !== "session.idle" && event.type !== "session.compaction.ended" && event.type !== "session.execution.failed") continue;
			const data = event.data as Record<string, unknown>;
			const id = typeof data.sessionID === "string" ? data.sessionID : undefined;
			if (!id || kernel.isAuxSession(id)) continue;
			const state = stateFor(id);
			if (event.type === "session.idle") void summarize(id, state);
			if (event.type === "session.compaction.ended") { state.priorCompactionCount += 1; persist(id, state); }
			if (event.type === "session.execution.failed") state.inFlight = false;
		}
	})().catch((error) => kernel.log(`online-context-compact event stream stopped: ${String(error)}`));
}
