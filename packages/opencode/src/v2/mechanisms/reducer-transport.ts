/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 ImKK666. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import type { ReducerModelResult } from "@alicekk/sol-opencode-core";
import { reducerInput, reducerInstructions } from "@alicekk/sol-opencode-core";
import type { V2Kernel } from "../kernel.ts";

export async function callV2ReducerModel(input: {
	readonly kernel: V2Kernel;
	readonly parentSessionID: string;
	readonly provider: string;
	readonly model: string;
	readonly timeoutMs: number;
	readonly command: string;
	readonly isError: boolean;
	readonly archive: Parameters<typeof reducerInput>[2];
	readonly body: string;
}): Promise<ReducerModelResult> {
	const created = await input.kernel.ctx.session.create({
		parentID: input.parentSessionID,
		title: "sol-reducer",
		location: { directory: input.kernel.ctx.location.directory },
	});
	const childID = created.id;
	input.kernel.markAuxSession(childID);
	try {
		await input.kernel.ctx.session.switchModel({ sessionID: childID, model: { providerID: input.provider, id: input.model } });
		const systemHook = await input.kernel.ctx.session.hook("context", (event) => {
			if (event.sessionID !== childID) return;
			event.system = [{ type: "text", text: reducerInstructions() }];
			event.tools = {};
		});
		try {
			let timeout: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					(async () => {
						await input.kernel.ctx.session.prompt({ sessionID: childID, text: reducerInput(input.command, input.isError, input.archive, input.body) });
						await input.kernel.ctx.session.wait({ sessionID: childID });
					})(),
					new Promise<never>((_resolve, reject) => {
						timeout = setTimeout(() => reject(new Error("reducer model call timed out")), input.timeoutMs);
					}),
				]);
			} finally {
				if (timeout !== undefined) clearTimeout(timeout);
			}
			const messages = await input.kernel.ctx.session.context({ sessionID: childID });
			const assistant = [...messages].reverse().find((message) => message.type === "assistant");
			const outputText = assistant?.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("") ?? "";
			const info = assistant as unknown as { model?: { providerID?: string; id?: string }; finish?: string; error?: unknown; tokens?: { input?: number; output?: number; cache?: { read?: number; write?: number } } } | undefined;
			const usage = info?.tokens;
			return {
				outputText,
				provider: info?.model?.providerID ?? input.provider,
				model: info?.model?.id ?? input.model,
				ok: info?.error === undefined,
				stopReason: info?.finish ?? (info?.error === undefined ? "stop" : "error"),
				errorMessage: info?.error === undefined ? undefined : String(info.error),
				usage: {
					input: usage?.input ?? 0,
					output: usage?.output ?? 0,
					cacheRead: usage?.cache?.read ?? 0,
					cacheWrite: usage?.cache?.write ?? 0,
					totalTokens: (usage?.input ?? 0) + (usage?.output ?? 0),
				},
			};
		} finally {
			await systemHook.dispose();
		}
	} finally {
		try { await input.kernel.ctx.session.remove({ sessionID: childID }); } finally { input.kernel.unmarkAuxSession(childID); }
	}
}
