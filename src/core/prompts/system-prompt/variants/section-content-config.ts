export interface SystemSectionContentConfig {
    readonly transport: "native" | "xml"
    readonly parallelTools: boolean
    readonly mcpEnabled: boolean
    readonly subagentsEnabled: boolean
    readonly subagentRun: boolean
    readonly focusChainEnabled: boolean
    readonly yoloModeEnabled: boolean
    readonly userInstructionsEnabled: boolean
    /** Web Search runs through Dline's local executor for this request. */
    readonly localWebSearchEnabled: boolean
    /** Web Search runs as a provider-hosted server tool for this request. */
    readonly serverWebSearchEnabled: boolean
}
