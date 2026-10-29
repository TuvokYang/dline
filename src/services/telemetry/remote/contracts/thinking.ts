/**
 * Thinking encoding of Usage schema 5 revision 1 (§3.2).
 *
 * The input is the request the final encoder actually sent. The reader knows
 * the parameter shapes of the provider families Dline encodes; it never infers
 * thinking from reasoning tokens or from the model name.
 */

export type UsageThinking = number | string

export const USAGE_THINKING_OFF = "state:off"
export const USAGE_THINKING_DYNAMIC = "state:dynamic"
export const USAGE_THINKING_DEFAULT = "state:default"
export const USAGE_THINKING_UNKNOWN = "state:unknown"

const LEVEL_MAX_LENGTH = 32
const LEVEL_DISALLOWED_CHARACTER = /[^a-z0-9_.-]/gu
const THINKING_STRING_PATTERN = /^(?:level:[a-z0-9_.-]{1,32}|state:(?:off|dynamic|default|unknown))$/u

type FieldPath = readonly string[]

/** Containers that carry provider-native request fields next to the top level. */
const NESTED_CONTAINERS = ["config", "generationConfig", "additionalModelRequestFields"] as const

const BUDGET_FIELDS: readonly FieldPath[] = [
    ["thinking", "budget_tokens"],
    ["thinkingConfig", "thinkingBudget"],
    ["thinking_budget"],
    ["reasoning", "max_tokens"],
    ["reasoning_config", "budget_tokens"],
]

const EFFORT_FIELDS: readonly FieldPath[] = [
    ["reasoning_effort"],
    ["reasoning", "effort"],
    ["output_config", "effort"],
    ["thinkingConfig", "thinkingLevel"],
    ["reasoningConfig", "maxReasoningEffort"],
]

interface SwitchField {
    readonly path: FieldPath
    readonly off: unknown
    readonly on: unknown
}

/** Non-budget switches; `on` without a budget or effort lets the provider choose how much to think. */
const SWITCH_FIELDS: readonly SwitchField[] = [
    { path: ["thinking", "type"], off: "disabled", on: "enabled" },
    { path: ["enable_thinking"], off: false, on: true },
    { path: ["think"], off: false, on: true },
    { path: ["reasoning", "enabled"], off: false, on: true },
    { path: ["reasoningConfig", "type"], off: "disabled", on: "enabled" },
]

const ADAPTIVE_FIELD: SwitchField = { path: ["thinking", "type"], off: undefined, on: "adaptive" }

export function projectUsageThinking(request: unknown): UsageThinking {
    if (!isRecord(request)) return USAGE_THINKING_UNKNOWN
    const containers = [request, ...NESTED_CONTAINERS.map((key) => request[key]).filter(isRecord)]

    const budget = firstPresent(containers, BUDGET_FIELDS)
    if (budget !== undefined) return isBudget(budget) ? normalizeZero(budget) : USAGE_THINKING_UNKNOWN

    const effort = firstPresent(containers, EFFORT_FIELDS)
    if (effort !== undefined) {
        const level = typeof effort === "string" ? normalizeLevel(effort) : ""
        return level ? `level:${level}` : USAGE_THINKING_UNKNOWN
    }

    const switches = SWITCH_FIELDS.map((field) => ({ field, value: firstPresent(containers, [field.path]) }))
    if (switches.some(({ field, value }) => value !== undefined && value === field.off)) return USAGE_THINKING_OFF
    if (firstPresent(containers, [ADAPTIVE_FIELD.path]) === ADAPTIVE_FIELD.on) return USAGE_THINKING_DYNAMIC
    if (switches.some(({ field, value }) => value !== undefined && value === field.on)) return USAGE_THINKING_DYNAMIC
    // A thinking parameter is present but has a shape the mapping table does not define.
    if (switches.some(({ value }) => value !== undefined)) return USAGE_THINKING_UNKNOWN
    return USAGE_THINKING_DEFAULT
}

export function isUsageThinking(value: unknown): value is UsageThinking {
    if (typeof value === "number") return isBudget(value) && !Object.is(value, -0)
    return typeof value === "string" && THINKING_STRING_PATTERN.test(value)
}

function isBudget(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && (value === -1 || value >= 0)
}

function normalizeZero(value: number): number {
    return value === 0 ? 0 : value
}

function normalizeLevel(value: string): string {
    return value.toLowerCase().replace(LEVEL_DISALLOWED_CHARACTER, "_").slice(0, LEVEL_MAX_LENGTH)
}

/** The first field value, in declaration order, that is present; `null` counts as absent like the SDKs treat it. */
function firstPresent(containers: readonly Record<string, unknown>[], fields: readonly FieldPath[]): unknown {
    for (const field of fields) {
        for (const container of containers) {
            const value = readPath(container, field)
            if (value !== undefined && value !== null) return value
        }
    }
    return undefined
}

function readPath(container: Record<string, unknown>, path: FieldPath): unknown {
    let current: unknown = container
    for (const key of path) {
        if (!isRecord(current)) return undefined
        current = current[key]
    }
    return current
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}
