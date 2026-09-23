import { PromptProfile } from "@core/prompts/profiles/types"
import type { SystemPromptContext } from "@core/prompts/system-prompt"
import type {
	PromptFreshnessBaseline,
	PromptFreshnessChange,
	PromptFreshnessChangeKind,
	PromptFreshnessSnapshot,
} from "@shared/PromptFreshness"
import type { SettingsKey } from "@shared/storage/state-keys"
import type { CapabilitiesSnapshot, CapabilityEntry } from "../capabilities/types"
import { hashPromptContent } from "./hash"

interface ComparePromptFreshnessOptions {
	readonly checkedAt: number
	readonly frozenAt?: number
}

const EMPTY_CAPABILITY_HASH = hashPromptContent("[]")

const PROMPT_FRESHNESS_SETTINGS_KEYS = new Set<SettingsKey>([
	"browserSettings",
	"clineWebToolsEnabled",
	"enableParallelToolCalling",
	"focusChainSettings",
	"imageGenerationEnabled",
	"lazyTeammateModeEnabled",
	"localWebSearchEngine",
	"mcpEnabled",
	"searxngSearchUrl",
	"subagentsEnabled",
])

/** Return whether a committed Settings revision can change the prompt freshness projection. */
export function settingsAffectPromptFreshness(changedKeys: readonly SettingsKey[]): boolean {
	return changedKeys.some((key) => PROMPT_FRESHNESS_SETTINGS_KEYS.has(key))
}

function hashPromptVisibleRules(context: SystemPromptContext): string {
	return hashPromptContent(
		JSON.stringify({
			globalDline: context.globalClineRulesFileInstructions ?? "",
			localDline: context.localClineRulesFileInstructions ?? "",
			cursorFile: context.localCursorRulesFileInstructions ?? "",
			cursorDirectory: context.localCursorRulesDirInstructions ?? "",
			windsurf: context.localWindsurfRulesFileInstructions ?? "",
			agents: context.localAgentsRulesFileInstructions ?? "",
		}),
	)
}

function hashCapabilityEntries(entries: readonly CapabilityEntry[], includeNativeToolIdentity = false): string {
	const normalized = entries
		.map((entry) => ({
			name: entry.name.trim(),
			description: entry.description.replace(/\s+/g, " ").trim(),
			contentHash: entry.contentHash ?? "",
			nativeToolHash: includeNativeToolIdentity ? (entry.nativeToolHash ?? "") : "",
		}))
		.filter((entry) => entry.name.length > 0)
		.sort(
			(left, right) =>
				left.name.localeCompare(right.name) ||
				left.description.localeCompare(right.description) ||
				left.contentHash.localeCompare(right.contentHash) ||
				left.nativeToolHash.localeCompare(right.nativeToolHash),
		)
	return hashPromptContent(JSON.stringify(normalized))
}

function snapshot(
	status: PromptFreshnessSnapshot["status"],
	changes: readonly PromptFreshnessChange[],
	options: ComparePromptFreshnessOptions,
): PromptFreshnessSnapshot {
	return {
		status,
		changes,
		checkedAt: options.checkedAt,
		...(options.frozenAt === undefined ? {} : { frozenAt: options.frozenAt }),
	}
}

/** Build the stable, content-safe prompt input projection persisted beside one frozen prompt. */
export function buildPromptFreshnessBaseline(
	context: SystemPromptContext,
	capabilities: CapabilitiesSnapshot,
): PromptFreshnessBaseline {
	const standardProfile = context.promptProfile === PromptProfile.Standard
	const subagentsVisible = standardProfile && context.subagentsEnabled === true
	const browserEnabled = context.supportsBrowserUse === true && context.browserSettings?.disableToolUse !== true
	const viewport = browserEnabled ? context.browserSettings?.viewport : undefined
	const webToolsVisible = standardProfile && context.clineWebToolsEnabled === true
	return {
		schemaVersion: 4,
		providerId: context.providerInfo.providerId,
		modelId: context.providerInfo.model.id,
		promptProfile: context.promptProfile,
		transport: context.enableNativeToolCalls === true ? "native" : "xml",
		parallelToolsEnabled: context.enableParallelToolCalling === true,
		imageGenerationAvailable: context.imageGenerationAvailable === true,
		imageModelId: context.imageModelId ?? "",
		browserEnabled,
		browserViewport: viewport ? `${viewport.width}x${viewport.height}` : "disabled",
		webToolsEnabled: webToolsVisible,
		webSearchRoute: webToolsVisible ? (context.webSearchRoutingPlan?.route ?? "none") : "disabled",
		webFetchRoute: webToolsVisible ? (context.webSearchRoutingPlan?.webFetchRoute ?? "none") : "disabled",
		focusChainEnabled: standardProfile && context.focusChainSettings?.enabled === true,
		rulesHash: hashPromptVisibleRules(context),
		subagentsEnabled: subagentsVisible,
		capabilityHashes: {
			mcp: hashCapabilityEntries(capabilities.mcp, context.enableNativeToolCalls === true),
			skills: standardProfile ? hashCapabilityEntries(capabilities.skills) : EMPTY_CAPABILITY_HASH,
			workflows: hashCapabilityEntries(capabilities.workflows),
			subagents: subagentsVisible ? hashCapabilityEntries(capabilities.subagents) : EMPTY_CAPABILITY_HASH,
		},
	}
}

function addChange(
	changes: Map<PromptFreshnessChangeKind, PromptFreshnessChange>,
	kind: PromptFreshnessChangeKind,
	summary: string,
): void {
	if (!changes.has(kind)) changes.set(kind, { kind, summary })
}

/** Compare a frozen baseline with the current projection without changing prompt or tool state. */
export function comparePromptFreshness(
	frozen: PromptFreshnessBaseline | undefined,
	current: PromptFreshnessBaseline,
	options: ComparePromptFreshnessOptions,
): PromptFreshnessSnapshot {
	if (!frozen || frozen.schemaVersion !== current.schemaVersion) return snapshot("unknown", [], options)

	const changes = new Map<PromptFreshnessChangeKind, PromptFreshnessChange>()
	if (frozen.providerId !== current.providerId) addChange(changes, "provider", "Provider changed")
	if (frozen.modelId !== current.modelId) addChange(changes, "model", "Model changed")
	if (frozen.promptProfile !== current.promptProfile) addChange(changes, "prompt_profile", "Prompt profile changed")
	if (frozen.transport !== current.transport || frozen.parallelToolsEnabled !== current.parallelToolsEnabled) {
		addChange(changes, "native_tools", "Tool calling settings changed")
	}
	if (frozen.imageGenerationAvailable !== current.imageGenerationAvailable || frozen.imageModelId !== current.imageModelId) {
		addChange(changes, "tool_set", "Image generation tools changed")
	}
	if (frozen.browserEnabled !== current.browserEnabled || frozen.browserViewport !== current.browserViewport) {
		addChange(changes, "browser", "Browser settings changed")
	}
	if (
		frozen.webToolsEnabled !== current.webToolsEnabled ||
		frozen.webSearchRoute !== current.webSearchRoute ||
		frozen.webFetchRoute !== current.webFetchRoute
	) {
		addChange(changes, "web_tools", "Web tools changed")
	}
	if (frozen.focusChainEnabled !== current.focusChainEnabled) addChange(changes, "focus_chain", "Focus Chain changed")
	if (frozen.rulesHash !== current.rulesHash) addChange(changes, "rules", "Rules changed")
	if (frozen.subagentsEnabled !== current.subagentsEnabled) addChange(changes, "subagents", "Subagents changed")
	if (frozen.capabilityHashes.mcp !== current.capabilityHashes.mcp) addChange(changes, "mcp", "MCP tools changed")
	if (frozen.capabilityHashes.skills !== current.capabilityHashes.skills) addChange(changes, "skills", "Skills changed")
	if (frozen.capabilityHashes.workflows !== current.capabilityHashes.workflows) {
		addChange(changes, "workflows", "Workflows changed")
	}
	if (frozen.capabilityHashes.subagents !== current.capabilityHashes.subagents) {
		addChange(changes, "subagents", "Subagents changed")
	}

	const ordered = Array.from(changes.values())
	return snapshot(ordered.length === 0 ? "fresh" : "stale", ordered, options)
}
