import type { CapabilityToggleState } from "@core/prompts/capabilities/CapabilitiesAggregator"
import type { CapabilitiesSnapshot } from "@core/prompts/capabilities/types"
import type { PromptProfile } from "@core/prompts/profiles/types"
import type { McpServer } from "@shared/mcp"
import type { ApiProviderInfo } from "@/core/api"
import type { WebSearchRoutingPlan } from "@/core/api/server-tools"
import type { BrowserSettings } from "@/shared/BrowserSettings"
import type { FocusChainSettings } from "@/shared/FocusChainSettings"
import type { SkillMetadata } from "@/shared/skills"
import type { TaskCapabilityToggles } from "@/shared/TaskCapabilityToggles"
import type { DlineDefaultTool } from "@/shared/tools"

/** Complete runtime context consumed by profile prompt generators. */
export interface SystemPromptContext {
    readonly taskId?: string
    readonly promptProfile: PromptProfile
    readonly providerInfo: ApiProviderInfo
    readonly cwd?: string
    readonly ide: string
    readonly supportsBrowserUse?: boolean
    /** Prompt-visible MCP projection. Execution still uses the real McpHub. */
    readonly mcpHub?: { getServers(): McpServer[] }
    readonly skills?: SkillMetadata[]
    readonly capabilities?: CapabilitiesSnapshot
    readonly capabilitiesSection?: string
    readonly capabilityToggleState?: CapabilityToggleState
    /** Complete Task-scoped execution snapshot frozen alongside prompt and tools. */
    readonly taskCapabilityToggles?: TaskCapabilityToggles
    readonly focusChainSettings?: FocusChainSettings
    readonly globalClineRulesFileInstructions?: string
    readonly localClineRulesFileInstructions?: string
    readonly localCursorRulesFileInstructions?: string
    readonly localCursorRulesDirInstructions?: string
    readonly localWindsurfRulesFileInstructions?: string
    readonly localAgentsRulesFileInstructions?: string
    readonly clineIgnoreInstructions?: string
    readonly preferredLanguageInstructions?: string
    readonly browserSettings?: BrowserSettings
    readonly isTesting?: boolean
    readonly runtimePlaceholders?: Readonly<Record<string, unknown>>
    readonly yoloModeToggled?: boolean
    readonly subagentsEnabled?: boolean
    readonly clineWebToolsEnabled?: boolean
    readonly webSearchRoutingPlan?: WebSearchRoutingPlan
    readonly imageGenerationAvailable?: boolean
    /** Image model ID of the currently bound image profile, used to select model-specific tool guidance. */
    readonly imageModelId?: string
    readonly isMultiRootEnabled?: boolean
    readonly workspaceRoots?: Array<{ path: string; name: string; vcs?: string }>
    readonly isSubagentsEnabledAndCliInstalled?: boolean
    readonly isCliSubagent?: boolean
    readonly isSubagentRun?: boolean
    readonly isCliEnvironment?: boolean
    readonly enableNativeToolCalls?: boolean
    readonly enableParallelToolCalling?: boolean
    readonly terminalExecutionMode?: "vscodeTerminal" | "backgroundExec"
    readonly defaultTerminalProfile?: string
    readonly terminalCommandTimeoutSeconds?: number
    readonly disableTools?: readonly DlineDefaultTool[]
}
