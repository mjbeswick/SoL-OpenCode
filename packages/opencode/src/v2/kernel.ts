/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 ImKK666. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import { Plugin } from "@opencode/plugin";
import type { SolConfig } from "../config.ts";
import { sessionRoot as computeSessionRoot } from "../storage.ts";

type PluginContext = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0];

export interface V2Kernel {
	readonly ctx: PluginContext;
	readonly config: SolConfig;
	sessionRoot(sessionID: string): string;
	isAuxSession(sessionID: string): boolean;
	markAuxSession(sessionID: string): void;
	unmarkAuxSession(sessionID: string): void;
	log(message: string): void;
}

export function createV2Kernel(ctx: PluginContext, config: SolConfig): V2Kernel {
	const auxSessions = new Set<string>();
	return {
		ctx,
		config,
		sessionRoot: (sessionID) => computeSessionRoot(ctx.location.directory, sessionID),
		isAuxSession: (sessionID) => auxSessions.has(sessionID),
		markAuxSession: (sessionID) => void auxSessions.add(sessionID),
		unmarkAuxSession: (sessionID) => void auxSessions.delete(sessionID),
		log: (message) => console.error(`[sol-opencode] ${message}`),
	};
}
