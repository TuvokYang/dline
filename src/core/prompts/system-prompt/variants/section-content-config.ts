export interface SystemSectionContentConfig {
    readonly transport: "native" | "xml"
    readonly parallelTools: boolean
    readonly mcpEnabled: boolean
    readonly subagentsEnabled: boolean
    readonly subagentRun: boolean
    readonly focusChainEnabled: boolean
    readonly yoloModeEnabled: boolean
    readonly userInstructionsEnabled: boolean
}
