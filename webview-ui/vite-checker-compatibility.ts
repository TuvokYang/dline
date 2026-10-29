interface LegacyTypeScriptCompilerApi {
    findConfigFile?: unknown
    createEmitAndSemanticDiagnosticsBuilderProgram?: unknown
    createWatchCompilerHost?: unknown
    createWatchProgram?: unknown
    sys?: {
        fileExists?: unknown
    }
}

/** Return whether TypeScript exposes the compiler host API required by vite-plugin-checker 0.14. */
export function supportsVitePluginCheckerTypeScript(value: unknown): boolean {
    if (typeof value !== "object" || value === null) return false
    const typescript = value as LegacyTypeScriptCompilerApi
    return (
        typeof typescript.findConfigFile === "function" &&
        typeof typescript.createEmitAndSemanticDiagnosticsBuilderProgram === "function" &&
        typeof typescript.createWatchCompilerHost === "function" &&
        typeof typescript.createWatchProgram === "function" &&
        typeof typescript.sys?.fileExists === "function"
    )
}
