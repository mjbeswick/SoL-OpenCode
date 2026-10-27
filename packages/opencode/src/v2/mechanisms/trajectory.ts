/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 ImKK666. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import { TrajectoryRecorder } from "@alicekk/sol-opencode-core";
import type { V2Kernel } from "../kernel.ts";

export async function registerV2Trajectory(
	kernel: V2Kernel,
	add: (registration: { dispose(): Promise<void> }) => void,
): Promise<void> {
	const maxRecords = kernel.config.trajectoryInspector.maxRecords;
	const recorders = new Map<string, TrajectoryRecorder>();
	const spans = new Map<string, { sequence: number; startedAt: number }>();
	const seenMessages = new Set<string>();
	const recorderFor = (sessionID: string): TrajectoryRecorder | undefined => {
		if (!sessionID || kernel.isAuxSession(sessionID)) return undefined;
		let recorder = recorders.get(sessionID);
		if (!recorder) {
			recorder = new TrajectoryRecorder(kernel.sessionRoot(sessionID), maxRecords);
			recorders.set(sessionID, recorder);
		}
		return recorder;
	};

	const toolHooks = await kernel.ctx.tool.hook("execute.before", (event) => {
		const recorder = recorderFor(event.sessionID);
		if (!recorder) return;
		const startedAt = Date.now();
		const result = recorder.record({ kind: "tool", label: `tool ${event.tool}`, status: "running", correlationId: String(event.id) }, startedAt);
		spans.set(`${event.sessionID}:${event.id}`, { sequence: result.sequence, startedAt });
	});
	add(toolHooks);
	add(await kernel.ctx.tool.hook("execute.after", (event) => {
		const recorder = recorderFor(event.sessionID);
		if (!recorder) return;
		const key = `${event.sessionID}:${event.id}`;
		const span = spans.get(key);
		if (span) {
			spans.delete(key);
			recorder.update(span.sequence, {
				status: event.status === "completed" ? "ok" : "error",
				durationMs: Math.max(0, Date.now() - span.startedAt),
			});
		} else {
			recorder.record({ kind: "tool", label: `tool ${event.tool}`, status: event.status === "completed" ? "ok" : "error" });
		}
	}));
	const toolRegistration = await kernel.ctx.tool.transform((editor) => {
		editor.add({
			name: "sol_trajectory",
			description: "Show recent metadata-only SoL trajectory records for this session.",
			input: { type: "object", properties: { limit: { type: "number" } }, additionalProperties: false } as never,
				execute: async (rawInput, context) => {
					const input = rawInput as { limit?: number };
				const recorder = recorders.get(context.sessionID);
				if (!recorder) return { content: "No trajectory records for this session." };
				const limit = typeof input.limit === "number" && input.limit > 0 ? input.limit : maxRecords;
				const records = recorder.store.snapshot().slice(-limit);
				return { content: records.length ? records.map((record) => `${record.sequence} ${new Date(record.timestamp).toISOString()} ${record.status} ${record.kind} ${record.label}${record.durationMs === undefined ? "" : ` (${Math.round(record.durationMs)}ms)`}`).join("\n") : "No trajectory records for this session." };
			},
		});
	});
	add(toolRegistration);
	const controller = new AbortController();
	add({ dispose: async () => controller.abort() });
	void (async () => {
		for await (const event of kernel.ctx.event.subscribe({ signal: controller.signal })) {
			const data = "data" in event && typeof event.data === "object" && event.data !== null ? event.data as Record<string, unknown> : {};
			const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined;
			if (!sessionID) continue;
			const recorder = recorderFor(sessionID);
			if (!recorder) continue;
			if (event.type === "session.created" || event.type === "session.deleted") {
				recorder.record({ kind: "session", label: event.type.replace("session.", "session "), status: "info" });
			} else if (event.type === "session.idle") {
				recorder.record({ kind: "turn", label: "turn end", status: "ok" });
			} else if (event.type === "session.tool.called") {
				spans.set(`${sessionID}:${String(data.id)}`, { sequence: recorder.record({ kind: "tool", label: "tool call", status: "running", correlationId: String(data.id) }).sequence, startedAt: Date.now() });
			} else if (event.type === "session.tool.success" || event.type === "session.tool.failed") {
				const key = `${sessionID}:${String(data.id)}`;
				const span = spans.get(key);
				if (span) {
					spans.delete(key);
					recorder.update(span.sequence, { status: event.type === "session.tool.success" ? "ok" : "error", durationMs: Math.max(0, Date.now() - span.startedAt) });
				}
			} else if (event.type === "session.compaction.ended") {
				recorder.record({ kind: "compact", label: "compaction", status: "ok" });
			} else if (event.type === "session.execution.failed") {
				recorder.record({ kind: "error", label: "session execution failed", status: "error" });
			} else if (event.type === "session.text.ended") {
				const messageID = typeof data.assistantMessageID === "string" ? data.assistantMessageID : undefined;
				if (!messageID || seenMessages.has(`${sessionID}:${messageID}`)) continue;
				seenMessages.add(`${sessionID}:${messageID}`);
				recorder.record({ kind: "message", label: "assistant message", status: "info" });
			}
		}
	})().catch((error) => kernel.log(`trajectory event stream stopped: ${String(error)}`));
}
