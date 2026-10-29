import { DISABLED_WEB_SEARCH_ROUTING_PLAN, HOSTED_WEB_SEARCH_ROUTING_PLAN } from "../../__tests__/web-search-routing-fixtures"
import type { SystemPromptContext } from "../context"

export type SnapshotProfile = "standard" | "lite"
export type SnapshotTransport = "native" | "xml"

export interface ProfileSnapshotCase {
    readonly id:
        | "basic"
        | "hosted-web"
        | "no-browser"
        | "no-mcp"
        | "no-focus"
        | "no-subagents"
        | "no-parallel"
        | "no-image"
        | "yolo"
        | "no-web"
    readonly overrides: Partial<SystemPromptContext>
}

export const PROFILE_SNAPSHOT_CASES: readonly ProfileSnapshotCase[] = [
    { id: "basic", overrides: {} },
    {
        id: "hosted-web",
        overrides: { webSearchRoutingPlan: HOSTED_WEB_SEARCH_ROUTING_PLAN },
    },
    {
        id: "no-browser",
        overrides: {
            supportsBrowserUse: false,
            browserSettings: { viewport: { width: 1280, height: 800 }, disableToolUse: true },
        },
    },
    { id: "no-mcp", overrides: { mcpHub: { getServers: () => [] } as unknown as SystemPromptContext["mcpHub"] } },
    { id: "no-focus", overrides: { focusChainSettings: { enabled: false, remindClineInterval: 0 } } },
    { id: "no-subagents", overrides: { subagentsEnabled: false } },
    { id: "no-parallel", overrides: { enableParallelToolCalling: false } },
    { id: "no-image", overrides: { imageGenerationAvailable: false } },
    { id: "yolo", overrides: { yoloModeToggled: true } },
    {
        id: "no-web",
        overrides: { clineWebToolsEnabled: false, webSearchRoutingPlan: DISABLED_WEB_SEARCH_ROUTING_PLAN },
    },
]

export const SNAPSHOT_PROFILES: readonly SnapshotProfile[] = ["standard", "lite"]
export const SNAPSHOT_TRANSPORTS: readonly SnapshotTransport[] = ["native", "xml"]

export function profileSnapshotName(
    profile: SnapshotProfile,
    transport: SnapshotTransport,
    caseId: ProfileSnapshotCase["id"],
    kind: "prompt" | "tools",
): string {
    return `${profile}.${transport}.${caseId}.${kind}.snap`
}
