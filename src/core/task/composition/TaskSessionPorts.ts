import type { TokenIncrement } from "@core/account-usage/daily-token-ledger"
import type { SystemPromptContext } from "@core/prompts/system-prompt"
import type { ClineRulesToggles } from "@shared/cline-rules"
import type { UiMessage } from "@shared/ExtensionMessage"
import type { InputSemanticCatalog } from "@shared/input-semantics/catalog"
import type { GetHostVersionResponse } from "@shared/proto/dline/host/env"
import type { TaskCollaborationRuntime } from "../collaboration/TaskCollaborationRuntime"
import type { NewTaskHandoff } from "../new-task/new-task-handoff"

/** Capability discovery needed to build one request's prompt context. */
export interface TaskPromptContextHost {
    getHostVersion(): Promise<GetHostVersionResponse>
    refreshClineRules(cwd: string): Promise<{
        readonly globalToggles: ClineRulesToggles
        readonly localToggles: ClineRulesToggles
    }>
    refreshExternalRules(cwd: string): Promise<{
        readonly windsurfLocalToggles: ClineRulesToggles
        readonly cursorLocalToggles: ClineRulesToggles
        readonly agentsLocalToggles: ClineRulesToggles
    }>
    refreshWorkflows(cwd: string): Promise<{
        readonly globalWorkflowToggles: ClineRulesToggles
        readonly localWorkflowToggles: ClineRulesToggles
    }>
    refreshSkills(): Promise<{
        readonly globalSkills: readonly {
            readonly name: string
            readonly path: string
            readonly enabled: boolean
        }[]
        readonly localSkills: readonly {
            readonly path: string
            readonly enabled: boolean
        }[]
    }>
    refreshSubagents(): Promise<{
        readonly globalSubagents: readonly { readonly path: string; readonly enabled: boolean }[]
        readonly localSubagents: readonly { readonly path: string; readonly enabled: boolean }[]
    }>
    /** Servers as the workspace on/off overlay shows them; seeds a task's default MCP toggles. */
    getMcpServers: NonNullable<SystemPromptContext["mcpHub"]>["getServers"]
    /**
     * Servers the task can reach, without the workspace overlay.
     *
     * The task's own toggles decide which of them enter its prompt, as the tool
     * handlers already decide which of them it may call.
     */
    getTaskMcpServers: NonNullable<SystemPromptContext["mcpHub"]>["getServers"]
}

/** IDE facts rendered into the request-scoped environment block. */
export interface TaskEnvironmentHost {
    getHostVersion(): Promise<GetHostVersionResponse>
    getVisibleFiles(): Promise<readonly string[]>
    getOpenTabs(): Promise<readonly string[]>
    buildActiveTasksSection(input: { readonly currentCwd: string; readonly excludeTaskId: string }): string
    /** How many task surfaces this window has open; request diagnostics report it. */
    activeTaskCount(): number
}

/** Delivers one already-persisted task row to its live surface. */
export interface TaskSessionPresentationPort {
    publish(row: UiMessage): Promise<void>
}

/** Shared catalog read by both Webview composition and Core admission. */
export interface TaskSessionSemanticCatalogPort {
    current(): InputSemanticCatalog
    discovered(): Promise<InputSemanticCatalog>
}

/** Starts a successor only after the source task was durably consumed. */
export interface TaskSessionSuccessorPort {
    start(sourceTaskId: string, handoff: NewTaskHandoff): Promise<void>
}

/** Records request usage against the Profile that served it. */
export interface TaskSessionProfileUsagePort {
    record(profileId: string, increment: TokenIncrement): Promise<void>
}

/** Host-owned effects used by the otherwise host-neutral task composition. */
export interface TaskSessionPorts {
    readonly collaboration: TaskCollaborationRuntime
    readonly promptContext: TaskPromptContextHost
    readonly environment: TaskEnvironmentHost
    readonly presentation: TaskSessionPresentationPort
    readonly semanticCatalog: TaskSessionSemanticCatalogPort
    readonly successor: TaskSessionSuccessorPort
    readonly profileUsage: TaskSessionProfileUsagePort
}
