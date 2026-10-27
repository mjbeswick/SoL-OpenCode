/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 ImKK666. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import { Plugin } from "@opencode/plugin";
import { parseConfig } from "../config.ts";
import { createV2Kernel } from "./kernel.ts";
import { registerV2ActionFusion } from "./mechanisms/action-fusion.ts";
import { registerV2ObservationPack } from "./mechanisms/observation-pack.ts";
import { registerV2Reducer } from "./mechanisms/reducer.ts";
import { registerV2Trajectory } from "./mechanisms/trajectory.ts";
import { registerV2OnlineContextCompact } from "./mechanisms/online-context-compact.ts";

export default Plugin.define({
	id: "sol-opencode",
	async setup(ctx) {
		const config = parseConfig(ctx.options);
		const kernel = createV2Kernel(ctx, config);
		const cleanup: Array<() => Promise<void>> = [];

		const add = <T extends { dispose(): Promise<void> }>(registration: T): void => {
			cleanup.push(() => registration.dispose());
		};

		if (config.trajectoryInspector.enabled) await registerV2Trajectory(kernel, add);
		if (config.actionFusion.enabled) await registerV2ActionFusion(kernel, add);
		if (config.evidencePreservingReducer.enabled) await registerV2Reducer(kernel, add);
		if (config.observationPack.enabled) await registerV2ObservationPack(kernel, add);
		if (config.onlineContextCompact.enabled) await registerV2OnlineContextCompact(kernel, add);

		return async () => {
			for (const dispose of cleanup.reverse()) await dispose();
		};
	},
});
