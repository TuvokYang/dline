import { FileEditProvider } from "@/integrations/editor/FileEditProvider"
import type { TaskConfig } from "../types/TaskConfig"

/**
 * Give one tool execution a non-visual, HostBridge-backed editor when Background Edit is enabled.
 *
 * The returned config is invocation-local. This prevents background writes from
 * opening or focusing editor tabs without replacing the Controller-owned visual
 * provider used by later foreground edits.
 */
export function withConfiguredEditProvider(config: TaskConfig): TaskConfig {
	if (config.services.stateManager?.getGlobalSettingsKey?.("backgroundEditEnabled") !== true) {
		return config
	}

	return {
		...config,
		services: {
			...config.services,
			diffViewProvider: new FileEditProvider(),
		},
	}
}
