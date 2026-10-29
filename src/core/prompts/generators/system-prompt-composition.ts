/**
 * UTF-8 byte sizes of the parts a generated system prompt is made of.
 *
 * Only the parts the context-window indicator breaks out are measured; the
 * rest of `totalBytes` is the base prompt, the subagent catalog included.
 */
export interface SystemPromptComposition {
    readonly totalBytes: number
    readonly userRulesBytes: number
    readonly skillsBytes: number
    readonly workflowsBytes: number
    /** XML tool documentation rendered into the prompt; native tool definitions travel apart from it. */
    readonly toolDefinitionsBytes: number
    /** The MCP catalog rendered into the prompt, which is all MCP contributes while its tools load on demand. */
    readonly mcpBytes: number
}

/** Text of the parts measured apart from the base prompt, as they were rendered into it. */
export interface SystemPromptCompositionParts {
    readonly systemPrompt: string
    readonly userRules: string
    readonly skills: string
    readonly workflows: string
    readonly toolDefinitions: string
    readonly mcp: string
}

const PART_KEYS = ["userRulesBytes", "skillsBytes", "workflowsBytes", "toolDefinitionsBytes"] as const

/** Measure one generated prompt; parts are clamped so they never exceed the prompt they were rendered into. */
export function measureSystemPromptComposition(parts: SystemPromptCompositionParts): SystemPromptComposition {
    const totalBytes = byteLength(parts.systemPrompt)
    let remaining = totalBytes
    const take = (text: string): number => {
        const bytes = Math.min(byteLength(text), remaining)
        remaining -= bytes
        return bytes
    }
    return {
        totalBytes,
        userRulesBytes: take(parts.userRules),
        skillsBytes: take(parts.skills),
        workflowsBytes: take(parts.workflows),
        toolDefinitionsBytes: take(parts.toolDefinitions),
        mcpBytes: take(parts.mcp),
    }
}

/**
 * Accept a persisted composition only when it is internally consistent.
 *
 * The frozen prompt cache is read back from disk, so an absent, partial, or
 * inconsistent value is treated as unmeasured rather than trusted.
 */
export function readSystemPromptComposition(value: unknown): SystemPromptComposition | undefined {
    if (!value || typeof value !== "object") return undefined
    const record = value as Record<string, unknown>
    if (!isByteCount(record.totalBytes)) return undefined
    let partsTotal = 0
    for (const key of PART_KEYS) {
        const bytes = record[key]
        if (!isByteCount(bytes)) return undefined
        partsTotal += bytes
    }
    // A prompt cached before the MCP catalog was measured apart counts it in the base prompt.
    const mcpBytes = record.mcpBytes === undefined ? 0 : record.mcpBytes
    if (!isByteCount(mcpBytes)) return undefined
    partsTotal += mcpBytes
    if (partsTotal > record.totalBytes) return undefined
    return {
        totalBytes: record.totalBytes,
        userRulesBytes: record.userRulesBytes as number,
        skillsBytes: record.skillsBytes as number,
        workflowsBytes: record.workflowsBytes as number,
        toolDefinitionsBytes: record.toolDefinitionsBytes as number,
        mcpBytes,
    }
}

function isByteCount(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function byteLength(text: string): number {
    return Buffer.byteLength(text, "utf8")
}
