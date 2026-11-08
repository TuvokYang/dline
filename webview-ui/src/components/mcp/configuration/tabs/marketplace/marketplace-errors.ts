/** Long-lived request failures keep diagnostics verbatim and translate only at render time. */
export interface McpMarketplaceError {
    kind: "load" | "install"
    diagnostics?: string
}
