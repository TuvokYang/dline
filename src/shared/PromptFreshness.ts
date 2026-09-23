export type PromptFreshnessStatus = "fresh" | "stale" | "unknown"

export type PromptFreshnessChangeKind =
	| "provider"
	| "model"
	| "prompt_profile"
	| "native_tools"
	| "browser"
	| "web_tools"
	| "focus_chain"
	| "rules"
	| "subagents"
	| "mcp"
	| "skills"
	| "workflows"
	| "tool_set"

/** Stable, content-safe projection persisted beside one frozen prompt. */
export interface PromptFreshnessBaseline {
	readonly schemaVersion: 4
	readonly providerId: string
	readonly modelId: string
	readonly promptProfile: "standard" | "lite"
	readonly transport: "native" | "xml"
	readonly parallelToolsEnabled: boolean
	readonly imageGenerationAvailable: boolean
	readonly imageModelId: string
	readonly browserEnabled: boolean
	readonly browserViewport: string
	readonly webToolsEnabled: boolean
	readonly webSearchRoute: string
	readonly webFetchRoute: string
	readonly focusChainEnabled: boolean
	readonly rulesHash: string
	readonly subagentsEnabled: boolean
	readonly capabilityHashes: {
		readonly mcp: string
		readonly skills: string
		readonly workflows: string
		readonly subagents: string
	}
}

/** One prompt-safe category summary shown in the refresh tooltip. */
export interface PromptFreshnessChange {
	readonly kind: PromptFreshnessChangeKind
	readonly summary: string
}

/** Minimal task-local prompt freshness state projected to the Webview. */
export interface PromptFreshnessSnapshot {
	readonly status: PromptFreshnessStatus
	readonly changes: readonly PromptFreshnessChange[]
	readonly frozenAt?: number
	readonly checkedAt: number
}
