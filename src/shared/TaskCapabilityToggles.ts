/**
 * Task-local enablement for prompt capabilities.
 *
 * The maps contain only stable resource identifiers and booleans. They never
 * contain MCP command lines, URLs with secrets, OAuth material, or tool data.
 */
export interface TaskCapabilityToggles {
    globalClineRulesToggles: Record<string, boolean>
    localClineRulesToggles: Record<string, boolean>
    localCursorRulesToggles: Record<string, boolean>
    localWindsurfRulesToggles: Record<string, boolean>
    localAgentsRulesToggles: Record<string, boolean>
    globalWorkflowToggles: Record<string, boolean>
    localWorkflowToggles: Record<string, boolean>
    globalSkillsToggles: Record<string, boolean>
    localSkillsToggles: Record<string, boolean>
    remoteSkillsToggles: Record<string, boolean>
    remoteRulesToggles: Record<string, boolean>
    remoteWorkflowToggles: Record<string, boolean>
    globalSubagentsToggles: Record<string, boolean>
    localSubagentsToggles: Record<string, boolean>
    mcpServers: Record<string, boolean>
}

export type TaskCapabilityToggleKey = keyof TaskCapabilityToggles

const TOGGLE_MAP_KEYS: readonly (keyof TaskCapabilityToggles)[] = [
    "globalClineRulesToggles",
    "localClineRulesToggles",
    "localCursorRulesToggles",
    "localWindsurfRulesToggles",
    "localAgentsRulesToggles",
    "globalWorkflowToggles",
    "localWorkflowToggles",
    "globalSkillsToggles",
    "localSkillsToggles",
    "remoteSkillsToggles",
    "remoteRulesToggles",
    "remoteWorkflowToggles",
    "globalSubagentsToggles",
    "localSubagentsToggles",
    "mcpServers",
]

export function emptyTaskCapabilityToggles(): TaskCapabilityToggles {
    return {
        globalClineRulesToggles: {},
        localClineRulesToggles: {},
        localCursorRulesToggles: {},
        localWindsurfRulesToggles: {},
        localAgentsRulesToggles: {},
        globalWorkflowToggles: {},
        localWorkflowToggles: {},
        globalSkillsToggles: {},
        localSkillsToggles: {},
        remoteSkillsToggles: {},
        remoteRulesToggles: {},
        remoteWorkflowToggles: {},
        globalSubagentsToggles: {},
        localSubagentsToggles: {},
        mcpServers: {},
    }
}

/** Normalize untrusted persisted/UI data into a complete snapshot. */
export function normalizeTaskCapabilityToggles(value: unknown): TaskCapabilityToggles {
    const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {}
    const result = emptyTaskCapabilityToggles()
    for (const key of TOGGLE_MAP_KEYS) {
        const raw = source[key]
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue
        const map: Record<string, boolean> = {}
        for (const [resourceId, enabled] of Object.entries(raw as Record<string, unknown>)) {
            if (typeof enabled === "boolean") map[resourceId] = enabled
        }
        result[key] = map
    }
    return result
}

export function parseTaskCapabilityToggles(value: unknown): TaskCapabilityToggles | undefined {
    if (typeof value !== "string" || value.trim() === "") return undefined
    try {
        return normalizeTaskCapabilityToggles(JSON.parse(value))
    } catch {
        return undefined
    }
}

/** Stable JSON makes task settings diffs and prompt refresh diagnostics readable. */
export function serializeTaskCapabilityToggles(value: unknown): string {
    const normalized = normalizeTaskCapabilityToggles(value)
    const sorted: Record<string, Record<string, boolean>> = {}
    for (const key of TOGGLE_MAP_KEYS) {
        sorted[key] = Object.fromEntries(Object.entries(normalized[key]).sort(([left], [right]) => left.localeCompare(right)))
    }
    return JSON.stringify(sorted)
}

/** Build a task snapshot from the currently effective global/workspace maps. */
export function createTaskCapabilityToggles(input: Partial<TaskCapabilityToggles>): TaskCapabilityToggles {
    return normalizeTaskCapabilityToggles(input)
}

export function updateTaskCapabilityToggle(
    current: TaskCapabilityToggles,
    key: TaskCapabilityToggleKey,
    resourceId: string,
    enabled: boolean,
): TaskCapabilityToggles {
    const normalized = normalizeTaskCapabilityToggles(current)
    return {
        ...normalized,
        [key]: {
            ...normalized[key],
            [resourceId]: enabled,
        },
    }
}

/**
 * Reconcile a task snapshot against currently discovered resources.
 * Existing values are preserved across partial or temporarily empty scans,
 * while newly discovered resources inherit their discovered default.
 * Explicit delete flows remove entries from their canonical stores.
 */
export function reconcileTaskCapabilityToggles(
    current: TaskCapabilityToggles,
    discovered: Partial<TaskCapabilityToggles>,
): TaskCapabilityToggles {
    const result = normalizeTaskCapabilityToggles(current)
    for (const key of TOGGLE_MAP_KEYS) {
        const discoveredMap = discovered[key]
        if (!discoveredMap) continue
        for (const [resourceId, defaultEnabled] of Object.entries(discoveredMap)) {
            if (!(resourceId in result[key])) result[key][resourceId] = defaultEnabled
        }
    }
    return result
}
