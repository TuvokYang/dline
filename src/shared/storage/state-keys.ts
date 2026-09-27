import { AutoApprovalSettings, DEFAULT_AUTO_APPROVAL_SETTINGS } from "@shared/AutoApprovalSettings"
import { ApiProvider, ModelInfo, type OcaModelInfo } from "@shared/api"
import {
	DEFAULT_AUTO_CONDENSE_MAX_CONTEXT_TOKENS,
	DEFAULT_AUTO_CONDENSE_MAX_RESERVE_TOKENS,
	DEFAULT_AUTO_CONDENSE_MIN_RESERVE_TOKENS,
	DEFAULT_AUTO_CONDENSE_TRIGGER_PERCENT,
	normalizeAutoCondenseMaxContextTokens,
	normalizeAutoCondenseReserveTokens,
	normalizeAutoCondenseTriggerPercent,
} from "@shared/auto-condense"
import { BrowserSettings, DEFAULT_BROWSER_SETTINGS } from "@shared/BrowserSettings"
import { type ChatInputSendShortcut, DEFAULT_CHAT_INPUT_SEND_SHORTCUT } from "@shared/ChatInputSendShortcut"
import { ClineRulesToggles } from "@shared/cline-rules"
import { DEFAULT_MAX_PARALLEL_SUBAGENTS, DEFAULT_MAX_PARALLEL_TOOL_CALLS } from "@shared/concurrency-limits"
import { DEFAULT_FOCUS_CHAIN_SETTINGS, FocusChainSettings } from "@shared/FocusChainSettings"
import { HistoryItem } from "@shared/HistoryItem"
import { DEFAULT_MCP_DISPLAY_MODE, McpDisplayMode } from "@shared/McpDisplayMode"
import { WorkspaceRoot } from "@shared/multi-root/types"
import { GlobalInstructionsFile } from "@shared/remote-config/schema"
import { Mode, OpenaiReasoningEffort } from "@shared/storage/types"
import { TelemetrySetting } from "@shared/TelemetrySetting"
import { DEFAULT_TERMINAL_COMMAND_HANDOFF_SECONDS, DEFAULT_TERMINAL_COMMAND_TIMEOUT_SECONDS } from "@shared/terminal-settings"
import { UserInfo } from "@shared/UserInfo"
import { DEFAULT_LOCAL_SEARCH_ENGINE, type LocalSearchEngineId } from "@shared/web-search"
import { type BlobStoreSettings } from "./types"

// ============================================================================
// SINGLE SOURCE OF TRUTH FOR STORAGE KEYS
//
// Property definitions with types, default values, and metadata
// NOTE: When adding a new field, scripts/generate-state-proto.mjs regenerates
// proto/dline/state.proto. The repository's staged-file hook runs the generator
// when this source is staged; manual verification should still inspect the generated diff.
// ============================================================================

/**
 * Defines the shape of a field definition. Each field must have a `default` value,
 * and optionally can have `isAsync`, `isComputed`, or `transform` metadata.
 *
 * The type casting on `default` (e.g., `true as boolean`) is necessary because
 * TypeScript would otherwise infer the literal type (`true`) instead of the
 * wider type (`boolean`). This ensures the generated interfaces allow any
 * value of that type, not just the default literal.
 */
type FieldDefinition<T> = {
	default: T // The default value for the field with proper type casting using as (e.g., `true as boolean | undefined`)
	isAsync?: boolean
	isComputed?: boolean
	transform?: (value: unknown) => T
}

type FieldDefinitions = Record<string, FieldDefinition<unknown>>

export type ConfiguredAPIKeys = Partial<Record<ApiProvider, boolean>>
const REMOTE_CONFIG_EXTRA_FIELDS = {
	remoteConfiguredProviders: { default: [] as ApiProvider[] },
	allowedMCPServers: { default: [] as Array<{ id: string }> },
	remoteMCPServers: { default: undefined as Array<{ name: string; url: string; alwaysEnabled?: boolean }> | undefined },
	previousRemoteMCPServers: { default: undefined as Array<{ name: string; url: string }> | undefined },
	remoteGlobalRules: { default: undefined as GlobalInstructionsFile[] | undefined },
	remoteGlobalWorkflows: { default: undefined as GlobalInstructionsFile[] | undefined },
	remoteGlobalSkills: { default: undefined as GlobalInstructionsFile[] | undefined },
	blockPersonalRemoteMCPServers: { default: false as boolean },
	openTelemetryOtlpHeaders: { default: undefined as Record<string, string> | undefined },
	otlpMetricsHeaders: { default: undefined as Record<string, string> | undefined },
	otlpLogsHeaders: { default: undefined as Record<string, string> | undefined },
	blobStoreConfig: { default: undefined as BlobStoreSettings | undefined },
	configuredApiKeys: { default: {} as ConfiguredAPIKeys | undefined },
} satisfies FieldDefinitions

const GLOBAL_STATE_FIELDS = {
	/** Extension version observed on the previous launch, used to detect updates. */
	version: { default: undefined as string | undefined },
	"cline.generatedMachineId": { default: undefined as string | undefined }, // Note, distinctId reads/writes this directly from/to StorageContext before StateManager is initialized.
	lastShownAnnouncementId: { default: undefined as string | undefined },
	taskHistory: { default: [] as HistoryItem[], isAsync: true },
	userInfo: { default: undefined as UserInfo | undefined },
	favoritedModelIds: { default: [] as string[] },
	/**
	 * Tokens Dline's own requests consumed today, per Profile ID. Subscription
	 * providers report no token counts, so usage surfaces show these instead.
	 */
	profileDailyTokenUsage: {
		default: {} as Record<string, { day: string; inputTokens: number; outputTokens: number }>,
	},
	mcpMarketplaceEnabled: { default: true as boolean },
	mcpResponsesCollapsed: { default: false as boolean },
	terminalReuseEnabled: { default: true as boolean },
	vscodeTerminalExecutionMode: {
		default: "vscodeTerminal" as "vscodeTerminal" | "backgroundExec",
	},
	isNewUser: { default: true as boolean },
	welcomeViewCompleted: { default: undefined as boolean | undefined },
	cliKanbanMigrationAnnouncementShown: { default: false as boolean },
	/**
	 * Highest completion-projection repair generation already applied.
	 *
	 * A plain "done" flag could never repair histories that a later defect
	 * damaged again, so the marker carries the generation it satisfied and the
	 * scan reruns once whenever a new defect raises
	 * `TASK_COMPLETION_BACKFILL_GENERATION`.
	 */
	taskCompletionBackfillGeneration: { default: 0 as number },
	mcpDisplayMode: { default: DEFAULT_MCP_DISPLAY_MODE as McpDisplayMode },
	workspaceRoots: { default: undefined as WorkspaceRoot[] | undefined },
	primaryRootIndex: { default: 0 as number },
	multiRootEnabled: { default: true as boolean },
	nativeToolCallEnabled: { default: true as boolean },
	remoteRulesToggles: { default: {} as ClineRulesToggles },
	remoteWorkflowToggles: { default: {} as ClineRulesToggles },
	remoteSkillsToggles: { default: {} as ClineRulesToggles },
	// Path to worktree that should auto-open Cline sidebar when launched
	worktreeAutoOpenPath: { default: undefined as string | undefined },
} satisfies FieldDefinitions

// Fields that map directly to ApiConfiguration in @shared/api.ts.
// All provider-specific fields (apiKey, baseUrl, modelId, modelInfo, etc.)
// are now sourced from ApiProfile + ModelRegistry at runtime.
const API_HANDLER_SETTINGS_FIELDS = {
	planModeProfileId: { default: undefined as string | undefined },
	planModeProfile: { default: undefined as string | undefined },
	actModeProfileId: { default: undefined as string | undefined },
	actModeProfile: { default: undefined as string | undefined },
	imageProfileId: { default: undefined as string | undefined },
	imageProfile: { default: undefined as string | undefined },
	requestTimeoutMs: { default: undefined as number | undefined },
	enableParallelToolCalling: { default: true as boolean },
} satisfies FieldDefinitions

const USER_SETTINGS_FIELDS = {
	// Settings that are NOT part of ApiHandlerOptions
	autoApprovalSettings: {
		default: DEFAULT_AUTO_APPROVAL_SETTINGS as AutoApprovalSettings,
	},
	// Capability toggles are sparse overrides resolved through global → workspace →
	// task. A path is present only when the user explicitly changed it at that
	// level, so an absent path means "inherit", never "disabled". Discovery never
	// writes these maps.
	globalClineRulesToggles: { default: {} as ClineRulesToggles },
	globalWorkflowToggles: { default: {} as ClineRulesToggles },
	globalSkillsToggles: { default: {} as Record<string, boolean> },
	globalSubagentsToggles: { default: {} as Record<string, boolean> },
	globalCursorRulesToggles: { default: {} as ClineRulesToggles },
	globalWindsurfRulesToggles: { default: {} as ClineRulesToggles },
	globalAgentsRulesToggles: { default: {} as ClineRulesToggles },
	globalMcpToggles: { default: {} as Record<string, boolean> },
	/** Workspace-scoped overrides. Stored in workspaces/<hash>/settings.json. */
	workspaceRulesToggles: { default: {} as ClineRulesToggles },
	workspaceWorkflowToggles: { default: {} as ClineRulesToggles },
	workspaceSkillsToggles: { default: {} as Record<string, boolean> },
	workspaceSubagentsToggles: { default: {} as Record<string, boolean> },
	workspaceCursorRulesToggles: { default: {} as ClineRulesToggles },
	workspaceWindsurfRulesToggles: { default: {} as ClineRulesToggles },
	workspaceAgentsRulesToggles: { default: {} as ClineRulesToggles },
	workspaceMcpToggles: { default: {} as Record<string, boolean> },
	/** Task-scoped overrides. Stored in tasks/<taskId>/settings.json. */
	taskRulesToggles: { default: {} as ClineRulesToggles },
	taskWorkflowToggles: { default: {} as ClineRulesToggles },
	taskSkillsToggles: { default: {} as Record<string, boolean> },
	taskSubagentsToggles: { default: {} as Record<string, boolean> },
	taskCursorRulesToggles: { default: {} as ClineRulesToggles },
	taskWindsurfRulesToggles: { default: {} as ClineRulesToggles },
	taskAgentsRulesToggles: { default: {} as ClineRulesToggles },
	taskMcpToggles: { default: {} as Record<string, boolean> },
	/** Serialized TaskCapabilityToggles snapshot. Only task settings use this field. */
	taskCapabilityToggles: { default: undefined as string | undefined },
	/** Task-local reasoning override fields. These never become global defaults. */
	planModeReasoningOverrideKind: { default: undefined as string | undefined },
	planModeReasoningOverrideEffort: { default: undefined as string | undefined },
	planModeThinkingBudgetTokens: { default: undefined as number | undefined },
	actModeReasoningOverrideKind: { default: undefined as string | undefined },
	actModeReasoningOverrideEffort: { default: undefined as string | undefined },
	actModeThinkingBudgetTokens: { default: undefined as number | undefined },
	planModeServiceTierOverrideKind: { default: undefined as string | undefined },
	planModeServiceTierOverrideTier: { default: undefined as string | undefined },
	actModeServiceTierOverrideKind: { default: undefined as string | undefined },
	actModeServiceTierOverrideTier: { default: undefined as string | undefined },
	browserSettings: {
		default: DEFAULT_BROWSER_SETTINGS as BrowserSettings,
		transform: (value: unknown) => ({
			...DEFAULT_BROWSER_SETTINGS,
			...(value && typeof value === "object" ? value : {}),
		}),
	},
	// Usage and error reporting are consented to separately. The former
	// `telemetrySetting` covered both at once and is deliberately not migrated:
	// an answer to the combined question does not answer either of these.
	usageReportingSetting: { default: "unset" as TelemetrySetting },
	errorReportingSetting: { default: "unset" as TelemetrySetting },
	planActSeparateModelsSetting: { default: false as boolean, isComputed: true },
	enableCheckpointsSetting: { default: true as boolean },
	shellIntegrationTimeout: { default: 4000 as number },
	defaultTerminalProfile: { default: "default" as string },
	terminalOutputLineLimit: { default: 500 as number },
	terminalCommandTimeoutSeconds: { default: DEFAULT_TERMINAL_COMMAND_TIMEOUT_SECONDS as number },
	terminalCommandHandoffSeconds: { default: DEFAULT_TERMINAL_COMMAND_HANDOFF_SECONDS as number },
	maxConsecutiveMistakes: { default: 3 as number },
	strictPlanModeEnabled: { default: false as boolean },
	hooksEnabled: { default: true as boolean },
	yoloModeToggled: { default: false as boolean },
	autoApproveAllToggled: { default: false as boolean },
	useAutoCondense: { default: false as boolean },
	autoCondenseTriggerPercent: {
		default: DEFAULT_AUTO_CONDENSE_TRIGGER_PERCENT as number,
		transform: normalizeAutoCondenseTriggerPercent,
	},
	autoCondenseMinReserveTokens: {
		default: DEFAULT_AUTO_CONDENSE_MIN_RESERVE_TOKENS as number,
		transform: (value: unknown) => normalizeAutoCondenseReserveTokens(value, DEFAULT_AUTO_CONDENSE_MIN_RESERVE_TOKENS),
	},
	autoCondenseMaxReserveTokens: {
		default: DEFAULT_AUTO_CONDENSE_MAX_RESERVE_TOKENS as number,
		transform: (value: unknown) => normalizeAutoCondenseReserveTokens(value, DEFAULT_AUTO_CONDENSE_MAX_RESERVE_TOKENS),
	},
	autoCondenseMaxContextTokens: {
		default: DEFAULT_AUTO_CONDENSE_MAX_CONTEXT_TOKENS as number,
		transform: normalizeAutoCondenseMaxContextTokens,
	},
	subagentsEnabled: { default: true as boolean },
	mcpEnabled: { default: true as boolean },
	imageGenerationEnabled: { default: false as boolean },
	clineWebToolsEnabled: { default: true as boolean },
	localWebSearchEngine: { default: DEFAULT_LOCAL_SEARCH_ENGINE as LocalSearchEngineId },
	searxngSearchUrl: { default: undefined as string | undefined },
	worktreesEnabled: { default: false as boolean },
	preferredLanguage: { default: "English" as string },
	chatInputSendShortcut: { default: DEFAULT_CHAT_INPUT_SEND_SHORTCUT as ChatInputSendShortcut },
	mode: { default: "act" as Mode },
	focusChainSettings: { default: DEFAULT_FOCUS_CHAIN_SETTINGS as FocusChainSettings },
	customPrompt: { default: undefined as "compact" | undefined },
	backgroundEditEnabled: { default: false as boolean },
	optOutOfRemoteConfig: { default: false as boolean },
	doubleCheckCompletionEnabled: { default: false as boolean },
	lazyTeammateModeEnabled: { default: false as boolean },
	showFeatureTips: { default: true as boolean },
	showActiveTasksInEnvDetails: { default: true as boolean },

	// Concurrency ceilings. These are two independent budgets: tool calls
	// contend for local editor, terminal and browser resources, while subagents
	// contend for provider capacity. Throttling a saturated provider must not
	// force local tool work to run serially, so neither limit derives from the
	// other. Both are clamped on read, because a persisted or remote value can
	// be out of range while the running limit must always be usable.
	maxParallelToolCalls: { default: DEFAULT_MAX_PARALLEL_TOOL_CALLS as number },
	maxParallelSubagents: { default: DEFAULT_MAX_PARALLEL_SUBAGENTS as number },

	// OpenTelemetry configuration
	openTelemetryEnabled: { default: true as boolean },
	openTelemetryMetricsExporter: { default: undefined as string | undefined },
	openTelemetryLogsExporter: { default: undefined as string | undefined },
	openTelemetryOtlpProtocol: { default: "http/json" as string | undefined },
	openTelemetryOtlpEndpoint: { default: "http://localhost:4318" as string | undefined },
	openTelemetryOtlpMetricsProtocol: { default: undefined as string | undefined },
	openTelemetryOtlpMetricsEndpoint: { default: undefined as string | undefined },
	openTelemetryOtlpLogsProtocol: { default: undefined as string | undefined },
	openTelemetryOtlpLogsEndpoint: { default: undefined as string | undefined },
	openTelemetryMetricExportInterval: { default: 60000 as number | undefined },
	openTelemetryOtlpInsecure: { default: false as boolean | undefined },
	openTelemetryLogBatchSize: { default: 512 as number | undefined },
	openTelemetryLogBatchTimeout: { default: 5000 as number | undefined },
	openTelemetryLogMaxQueueSize: { default: 2048 as number | undefined },

	// @deprecated — Replaced by planModeProfile / actModeProfile (ApiProfile-driven model selection)
	planModeOcaModelId: { default: undefined as string | undefined },
	// @deprecated
	planModeOcaModelInfo: { default: undefined as OcaModelInfo | undefined },
	// @deprecated
	planModeOcaReasoningEffort: { default: undefined as string | undefined },
	// @deprecated
	actModeOcaModelId: { default: undefined as string | undefined },
	// @deprecated
	actModeOcaModelInfo: { default: undefined as OcaModelInfo | undefined },
	// @deprecated
	actModeOcaReasoningEffort: { default: undefined as string | undefined },
	// @deprecated
	planModeOpenRouterModelId: { default: undefined as string | undefined },
	// @deprecated
	planModeOpenRouterModelInfo: { default: undefined as ModelInfo | undefined },
	// @deprecated
	actModeOpenRouterModelId: { default: undefined as string | undefined },
	// @deprecated
	actModeOpenRouterModelInfo: { default: undefined as ModelInfo | undefined },

	// Provider base URL overrides
	liteLlmBaseUrl: { default: undefined as string | undefined },
	requestyBaseUrl: { default: undefined as string | undefined },

	// OCA configuration
	ocaMode: { default: undefined as string | undefined },

	// @deprecated — Replaced by ApiProfile.modelInfo.capabilities.thinking.effortLevels
	planModeReasoningEffort: { default: undefined as OpenaiReasoningEffort | undefined },
	// @deprecated
	actModeReasoningEffort: { default: undefined as OpenaiReasoningEffort | undefined },
} satisfies FieldDefinitions

const SETTINGS_FIELDS = { ...API_HANDLER_SETTINGS_FIELDS, ...USER_SETTINGS_FIELDS }
const GLOBAL_STATE_AND_SETTINGS_FIELDS = { ...GLOBAL_STATE_FIELDS, ...SETTINGS_FIELDS }

// ============================================================================
// SECRET KEYS AND LOCAL STATE - Static definitions
// ============================================================================

// Secret keys used in Api Configuration
const SECRETS_KEYS = [
	"apiKey",
	"clineApiKey",
	"clineAccountId", // Cline Account ID for Firebase
	"cline:clineAccountId",
	"openRouterApiKey",
	"awsAccessKey",
	"awsSecretKey",
	"awsSessionToken",
	"awsBedrockApiKey",
	"openAiApiKey",
	"geminiApiKey",
	"openAiNativeApiKey",
	"ollamaApiKey",
	"deepSeekApiKey",
	"requestyApiKey",
	"togetherApiKey",
	"fireworksApiKey",
	"qwenApiKey",
	"doubaoApiKey",
	"mistralApiKey",
	"liteLlmApiKey",
	"authNonce",
	"asksageApiKey",
	"xaiApiKey",
	"moonshotApiKey",
	"zaiApiKey",
	"huggingFaceApiKey",
	"nebiusApiKey",
	"sambanovaApiKey",
	"cerebrasApiKey",
	"sapAiCoreClientId",
	"sapAiCoreClientSecret",
	"groqApiKey",
	"huaweiCloudMaasApiKey",
	"basetenApiKey",
	"vercelAiGatewayApiKey",
	"difyApiKey",
	"minimaxApiKey",
	"hicapApiKey",
	"aihubmixApiKey",
	"nousResearchApiKey",
	"remoteLiteLlmApiKey",
	"ocaApiKey",
	"ocaRefreshToken",
	"mcpOAuthSecrets",
	"searxngSearchToken",
	"wandbApiKey",
] as const

// WARNING, these are not ALL of the local state keys in practice. For example, FileContextTracker
// uses dynamic keys like pendingFileContextWarning_${taskId}.
export const LocalStateKeys = [
	"mcpServersToggles",
	// Mirrors of the last trustworthy capability scan, kept so a restart shows
	// the previously discovered resources instead of an empty panel. These are a
	// display cache, never a preference: user intent lives in the scope chain.
	"discoveredRulesToggles",
	"discoveredWorkflowToggles",
	"discoveredSkillsToggles",
	"discoveredSubagentsToggles",
	"discoveredCursorRulesToggles",
	"discoveredWindsurfRulesToggles",
	"discoveredAgentsRulesToggles",
] as const

// ============================================================================
// GENERATED TYPES - Auto-generated from property definitions
// ============================================================================

type ExtractDefault<T> = T extends { default: infer U } ? U : never
type BuildInterface<T extends Record<string, { default: unknown }>> = { [K in keyof T]: ExtractDefault<T[K]> }

export type GlobalState = BuildInterface<typeof GLOBAL_STATE_FIELDS>
export type Settings = BuildInterface<typeof SETTINGS_FIELDS>
type RemoteConfigExtra = BuildInterface<typeof REMOTE_CONFIG_EXTRA_FIELDS>
export type ApiHandlerOptionSettings = BuildInterface<typeof API_HANDLER_SETTINGS_FIELDS>
export type ApiHandlerSettings = ApiHandlerOptionSettings & Secrets
export type GlobalStateAndSettings = GlobalState & Settings
export type RemoteConfigFields = GlobalStateAndSettings & RemoteConfigExtra

// ============================================================================
// TYPE ALIASES
// ============================================================================

export type Secrets = { [K in (typeof SecretKeys)[number]]: string | undefined }
export type LocalState = { [K in (typeof LocalStateKeys)[number]]: ClineRulesToggles }
export type SecretKey = (typeof SecretKeys)[number]
export type GlobalStateKey = keyof GlobalState
export type LocalStateKey = keyof LocalState
export type SettingsKey = keyof Settings
export type GlobalStateAndSettingsKey = keyof GlobalStateAndSettings

// ============================================================================
// GENERATED KEYS AND LOOKUP SETS - Auto-generated from property definitions
// ============================================================================

const GlobalStateKeys = new Set(Object.keys(GLOBAL_STATE_FIELDS))
const SettingsKeysSet = new Set(Object.keys(SETTINGS_FIELDS))
const GlobalStateAndSettingsKeySet = new Set(Object.keys(GLOBAL_STATE_AND_SETTINGS_FIELDS))
const ApiHandlerSettingsKeysSet = new Set(Object.keys(API_HANDLER_SETTINGS_FIELDS))

export const SecretKeys = Array.from(SECRETS_KEYS)
export const SettingsKeys = Array.from(SettingsKeysSet) as (keyof Settings)[]
export const ApiHandlerSettingsKeys = Array.from(ApiHandlerSettingsKeysSet) as (keyof ApiHandlerOptionSettings)[]
export const GlobalStateAndSettingKeys = Array.from(GlobalStateAndSettingsKeySet) as GlobalStateAndSettingsKey[]

// GENERATED DEFAULTS - Auto-generated from property definitions
// ============================================================================

export const GLOBAL_STATE_DEFAULTS = extractDefaults(GLOBAL_STATE_FIELDS)
export const SETTINGS_DEFAULTS = extractDefaults(SETTINGS_FIELDS)
export const SETTINGS_TRANSFORMS = extractTransforms(SETTINGS_FIELDS)
export const ASYNC_PROPERTIES = extractMetadata({ ...GLOBAL_STATE_FIELDS, ...SETTINGS_FIELDS }, "isAsync")
export const COMPUTED_PROPERTIES = extractMetadata({ ...GLOBAL_STATE_FIELDS, ...SETTINGS_FIELDS }, "isComputed")

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

export const isGlobalStateKey = (key: string): key is GlobalStateKey => GlobalStateKeys.has(key)
export const isSettingsKey = (key: string): key is SettingsKey => SettingsKeysSet.has(key)
export const isSecretKey = (key: string): key is SecretKey => new Set(SECRETS_KEYS).has(key as SecretKey)
export const isLocalStateKey = (key: string): key is LocalStateKey => new Set(LocalStateKeys).has(key as LocalStateKey)

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

export const isAsyncProperty = (key: string): boolean => ASYNC_PROPERTIES.has(key)
export const isComputedProperty = (key: string): boolean => COMPUTED_PROPERTIES.has(key)

export const getDefaultValue = <K extends GlobalStateAndSettingsKey>(key: K): GlobalStateAndSettings[K] | undefined => {
	const globalDefaults = GLOBAL_STATE_DEFAULTS as Partial<Record<GlobalStateAndSettingsKey, unknown>>
	const settingsDefaults = SETTINGS_DEFAULTS as Partial<Record<GlobalStateAndSettingsKey, unknown>>
	return (globalDefaults[key] ?? settingsDefaults[key]) as GlobalStateAndSettings[K] | undefined
}

export const hasTransform = (key: string): boolean => key in SETTINGS_TRANSFORMS
export const applyTransform = <T>(key: string, value: T): T => {
	const transform = SETTINGS_TRANSFORMS[key]
	return transform ? (transform(value) as T) : value
}

function extractDefaults<T extends Record<string, { default: unknown }>>(props: T): Partial<BuildInterface<T>> {
	return Object.fromEntries(
		Object.entries(props)
			.map(([key, prop]) => [key, prop.default])
			.filter(([_, value]) => value !== undefined),
	) as Partial<BuildInterface<T>>
}

type FieldTransform = (value: unknown) => unknown

function extractTransforms<T extends FieldDefinitions>(props: T): Record<string, FieldTransform> {
	return Object.fromEntries(
		Object.entries(props)
			.filter((entry): entry is [string, FieldDefinition<unknown> & { transform: FieldTransform }] =>
				Boolean(entry[1].transform),
			)
			.map(([key, prop]) => [key, prop.transform]),
	)
}

function extractMetadata(props: Record<string, object>, field: string): Set<string> {
	return new Set(
		Object.entries(props)
			.filter(([_, prop]) => field in prop && (prop as Record<string, unknown>)[field] === true)
			.map(([key]) => key),
	)
}
