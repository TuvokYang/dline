export type LoadCapabilityKind = "mcp" | "skill" | "workflow"

export type LoadCapabilityStatus = "loading" | "completed" | "failed"

export type LoadCapabilitySource = "mcp" | "project" | "global" | "remote" | "workspace"

export interface LoadCapabilityDetail {
	label: string
	value: string | string[] | Record<string, unknown>
}

export interface LoadCapabilityPayload {
	tool: "loadCapability"
	kind: LoadCapabilityKind
	status: LoadCapabilityStatus
	name: string
	source?: LoadCapabilitySource
	summary?: string
	details?: LoadCapabilityDetail[]
	body?: string
	error?: string
	enabled?: boolean
}

/**
 * Build the stable tool name for a load capability kind.
 *
 * @param kind Capability family handled by the load tools.
 * @returns Stable tool name exposed to models.
 */
export function buildLoadToolName(kind: LoadCapabilityKind): string {
	return `load_${kind}`
}

/**
 * Create a loading payload for Webview rendering.
 *
 * @param kind Capability family currently loading.
 * @param name Capability name requested by the model.
 * @returns Structured payload for UiSayTool messages.
 */
export function createLoadingPayload(kind: LoadCapabilityKind, name: string): LoadCapabilityPayload {
	return {
		tool: "loadCapability",
		kind,
		status: "loading",
		name,
	}
}

/**
 * Create a failed payload for Webview rendering and model feedback.
 *
 * @param kind Capability family that failed to load.
 * @param name Capability name requested by the model.
 * @param error Human-readable failure reason.
 * @returns Structured payload for UiSayTool messages.
 */
export function createFailedPayload(kind: LoadCapabilityKind, name: string, error: string): LoadCapabilityPayload {
	return {
		tool: "loadCapability",
		kind,
		status: "failed",
		name,
		error,
		enabled: false,
	}
}
