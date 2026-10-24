/**
 * Execution metrics of a canonical Usage fact.
 *
 * Three bounded structures describe how a fact executed rather than how much it
 * consumed:
 *
 * - `tools.by_name` drills the fact-level tool outcomes down to a tool name;
 * - `todos` counts checklist progress and the rounds a completion needed;
 * - `task_attempts` describes how many attempts one logical request took.
 *
 * They are ordinary structured fields, never opaque containers: a JSON or blob
 * column cannot be filtered by tool name, cannot be indexed and cannot serve as
 * a cleanup selector, which is exactly what tool-failure analysis needs.
 *
 * Every structure is optional. Absence means "not reported" and must never be
 * read as zero, because a role without tool settlement facts or without a
 * checklist is not a role that executed zero tools or finished zero TODOs.
 */

/**
 * A tool name is a registered identity, never free text. The pattern is the
 * contract form of `DlineDefaultTool` values plus the stable `mcp.*` category
 * prefix, so a user-configured MCP server name can never reach the wire.
 */
export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_.-]{1,47}$/
export const MAX_TOOL_NAMES_PER_FACT = 12
/** Stable category used instead of a user-chosen MCP server name. */
export const MCP_TOOL_CATEGORY = "mcp.remote"

/** Integer bucket upper bounds of `rounds_to_complete`; the eleventh bucket is the overflow. */
export const TODO_ROUND_BOUNDS = [1, 2, 3, 4, 5, 7, 10, 15, 25, 50] as const
export const TODO_ROUND_BUCKETS = TODO_ROUND_BOUNDS.length + 1

/** The three outcomes every tool counter uses, in canonical order. */
export const TOOL_OUTCOMES = ["completed", "failed", "cancelled"] as const
export type ToolOutcome = (typeof TOOL_OUTCOMES)[number]

/** The transitions a checklist item can report. */
export const TODO_TRANSITIONS = ["declared", "completed", "reopened", "abandoned"] as const
export type TodoTransition = (typeof TODO_TRANSITIONS)[number]

export interface ToolOutcomeCounts {
    readonly completed: number
    readonly failed: number
    readonly cancelled: number
}

/**
 * Tool outcomes of one fact.
 *
 * `by_name` holds at most {@link MAX_TOOL_NAMES_PER_FACT} entries. Every further
 * name contributes to `unlisted` instead of being dropped, so the three totals
 * stay trustworthy even when the client and the reader disagree about the tool
 * catalog.
 */
export interface UsageToolsWire extends ToolOutcomeCounts {
    readonly by_name?: Readonly<Record<string, ToolOutcomeCounts>>
    readonly unlisted?: ToolOutcomeCounts
}

/**
 * A `{count,sum,min,max}` summary that may legitimately have no samples.
 *
 * `count = 0` requires the other members to be 0, so an empty summary can never
 * masquerade as a measured zero-duration event.
 */
export interface ExecutionSummary {
    readonly count: number
    readonly sum: number
    readonly min: number
    readonly max: number
}

/** Integer distribution of the rounds a TODO completion needed. */
export interface RoundsDistribution extends ExecutionSummary {
    readonly buckets: readonly number[]
}

/**
 * TODO efficiency of one fact.
 *
 * `rounds_to_complete.count` is deliberately allowed to be lower than
 * `completed`: a completion whose first-seen record is gone after a restart is
 * still a completion, but it has no honest round count, so it contributes no
 * sample instead of a fabricated one.
 */
export interface UsageTodosWire {
    readonly declared: number
    readonly completed: number
    readonly reopened: number
    readonly abandoned: number
    readonly rounds_to_complete?: RoundsDistribution
    readonly active_ms_to_complete?: ExecutionSummary
}

/** How many attempts the logical requests of one fact needed. */
export interface UsageTaskAttemptsWire extends ExecutionSummary {}

export type ExecutionMetricsViolation =
    | "tools_by_name_key"
    | "tools_by_name_limit"
    | "tools_conservation"
    | "todos_counters"
    | "todos_rounds"
    | "todos_active_ms"
    | "task_attempts"

/** A fact key plus tool counters, as the truncation step needs them. */
export interface ToolNameCandidate extends ToolOutcomeCounts {
    readonly factKey: string
    readonly toolName: string
}

/** A zero summary; used when a fact has counters but no samples of one kind. */
export const EMPTY_EXECUTION_SUMMARY: ExecutionSummary = { count: 0, sum: 0, min: 0, max: 0 }

export function isCount(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

export function isOutcomeCounts(value: unknown): value is ToolOutcomeCounts {
    if (typeof value !== "object" || value === null) return false
    const counts = value as Record<string, unknown>
    return TOOL_OUTCOMES.every((outcome) => isCount(counts[outcome]))
}

function outcomeTotal(counts: ToolOutcomeCounts): number {
    return counts.completed + counts.failed + counts.cancelled
}

export function isRegisteredToolName(name: string): boolean {
    return TOOL_NAME_PATTERN.test(name)
}

/**
 * Compare two tool counters for truncation: busiest first, then by name.
 *
 * The comparison is total for a fixed set of candidates, so truncating the same
 * snapshot always selects the same names no matter how the map was built.
 */
export function compareToolCandidates(left: ToolNameCandidate, right: ToolNameCandidate): number {
    const byTotal = outcomeTotal(right) - outcomeTotal(left)
    if (byTotal !== 0) return byTotal
    const byName = left.toolName.localeCompare(right.toolName)
    if (byName !== 0) return byName
    // Two different facts may carry the same tool name; the fact key breaks the tie
    // so the selected set and the remainder are both deterministic.
    return left.factKey.localeCompare(right.factKey)
}

/**
 * Split candidates into the names that fit the per-fact bound and the remainder
 * that must be folded into `unlisted`.
 *
 * Grouping is per fact: the bound applies to one fact's `by_name` map, not to
 * the whole batch. Within a fact the busiest names win, so the truncated view
 * stays useful while `unlisted` keeps the totals exact.
 */
export function selectToolNames(
    candidates: readonly ToolNameCandidate[],
    limit = MAX_TOOL_NAMES_PER_FACT,
): { readonly selected: readonly ToolNameCandidate[]; readonly unlisted: readonly ToolNameCandidate[] } {
    if (limit <= 0) return { selected: [], unlisted: [...candidates] }
    const byFact = new Map<string, ToolNameCandidate[]>()
    for (const candidate of candidates) {
        const bucket = byFact.get(candidate.factKey)
        if (bucket) bucket.push(candidate)
        else byFact.set(candidate.factKey, [candidate])
    }
    const selected: ToolNameCandidate[] = []
    const unlisted: ToolNameCandidate[] = []
    for (const bucket of byFact.values()) {
        const ordered = [...bucket].sort(compareToolCandidates)
        selected.push(...ordered.slice(0, limit))
        unlisted.push(...ordered.slice(limit))
    }
    return { selected, unlisted }
}

/**
 * Enforce the per-fact name bound on one tools object.
 *
 * A producer that already holds too many names must fold the extras into
 * `unlisted` before the body is written: the reader rejects a `by_name` map over
 * the bound, and dropping the extras would break conservation instead.
 */
export function foldToolsToBound(tools: UsageToolsWire, limit = MAX_TOOL_NAMES_PER_FACT): UsageToolsWire {
    const names = Object.entries(tools.by_name ?? {})
    if (names.length <= limit) return tools
    const candidates: ToolNameCandidate[] = names.map(([toolName, counts]) => ({ factKey: "", toolName, ...counts }))
    const { selected, unlisted } = selectToolNames(candidates, limit)
    const byName: Record<string, ToolOutcomeCounts> = {}
    for (const entry of selected) {
        byName[entry.toolName] = { completed: entry.completed, failed: entry.failed, cancelled: entry.cancelled }
    }
    return {
        completed: tools.completed,
        failed: tools.failed,
        cancelled: tools.cancelled,
        by_name: byName,
        unlisted: addOutcomeCounts(tools.unlisted ?? { completed: 0, failed: 0, cancelled: 0 }, sumOutcomeCounts(unlisted)),
    }
}

function addOutcomeCounts(left: ToolOutcomeCounts, right: ToolOutcomeCounts): ToolOutcomeCounts {
    return {
        completed: left.completed + right.completed,
        failed: left.failed + right.failed,
        cancelled: left.cancelled + right.cancelled,
    }
}

/** Sum counters of several names into one, for the `unlisted` remainder. */
export function sumOutcomeCounts(entries: readonly ToolOutcomeCounts[]): ToolOutcomeCounts {
    let completed = 0
    let failed = 0
    let cancelled = 0
    for (const entry of entries) {
        completed += entry.completed
        failed += entry.failed
        cancelled += entry.cancelled
    }
    return { completed, failed, cancelled }
}

/** Violations of one tools object; empty when the reader would accept it. */
export function validateTools(tools: UsageToolsWire): ExecutionMetricsViolation[] {
    const violations: ExecutionMetricsViolation[] = []
    if (!isOutcomeCounts(tools)) return ["tools_conservation"]
    const byName = tools.by_name
    if (byName !== undefined) {
        const names = Object.keys(byName)
        if (names.some((name) => !isRegisteredToolName(name))) violations.push("tools_by_name_key")
        if (names.length > MAX_TOOL_NAMES_PER_FACT) violations.push("tools_by_name_limit")
        if (!names.every((name) => isOutcomeCounts(byName[name]))) return [...violations, "tools_conservation"]
        const listed = sumOutcomeCounts(names.map((name) => byName[name]))
        const remainder = tools.unlisted ?? { completed: 0, failed: 0, cancelled: 0 }
        if (!isOutcomeCounts(remainder)) return [...violations, "tools_conservation"]
        // Each outcome must be fully accounted for: a name either contributes to
        // by_name or to the unlisted remainder, never to neither and never to both.
        for (const outcome of TOOL_OUTCOMES) {
            if (listed[outcome] + remainder[outcome] !== tools[outcome]) violations.push("tools_conservation")
        }
    } else if (tools.unlisted !== undefined && outcomeTotal(tools.unlisted) !== 0) {
        // `unlisted` without `by_name` would claim results the fact does not carry.
        violations.push("tools_conservation")
    }
    return violations
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isConsistentSampleSummary(value: unknown, empty: ExecutionSummary): value is ExecutionSummary {
    if (!isRecord(value)) return false
    const { count, sum, min, max } = value
    if (!isCount(count) || !isCount(sum) || !isCount(min) || !isCount(max)) return false
    if (count === 0) return sum === empty.sum && min === empty.min && max === empty.max
    if (min > max) return false
    if (min * count > sum) return false
    return sum <= max * count
}

/** Violations of one todos object; empty when the reader would accept it. */
export function validateTodos(todos: UsageTodosWire): ExecutionMetricsViolation[] {
    const violations: ExecutionMetricsViolation[] = []
    const counters = [todos.declared, todos.completed, todos.reopened, todos.abandoned]
    if (!counters.every(isCount)) return ["todos_counters"]
    // A completion may be reported for an item that was declared in an earlier
    // batch, so declared and reopened together bound the completions.
    if (todos.completed > todos.declared + todos.reopened) violations.push("todos_counters")
    if (todos.reopened > todos.completed) violations.push("todos_counters")

    const rounds = todos.rounds_to_complete
    if (rounds !== undefined && !isCount(rounds.count)) {
        violations.push("todos_rounds")
    } else if (rounds !== undefined) {
        if (!Array.isArray(rounds.buckets) || rounds.buckets.length !== TODO_ROUND_BUCKETS) {
            violations.push("todos_rounds")
        } else if (!rounds.buckets.every(isCount)) {
            violations.push("todos_rounds")
        } else {
            if (rounds.buckets.reduce((total, value) => total + value, 0) !== rounds.count) violations.push("todos_rounds")
            // Missing first-seen records lower the sample count; they never raise it.
            if (rounds.count > todos.completed) violations.push("todos_rounds")
            if (rounds.count > 0 && rounds.min < 1) violations.push("todos_rounds")
            if (!isConsistentSampleSummary(rounds, EMPTY_EXECUTION_SUMMARY)) violations.push("todos_rounds")
        }
    }

    const active = todos.active_ms_to_complete
    if (active !== undefined) {
        // Both distributions describe the same completions, so their sample counts agree.
        const expected = rounds?.count ?? 0
        if (!isConsistentSampleSummary(active, EMPTY_EXECUTION_SUMMARY) || active.count !== expected) {
            violations.push("todos_active_ms")
        }
    }
    return violations
}

/** Where a rounds sample falls: the first bucket whose bound is not exceeded, else the overflow. */
export function todoRoundBucket(rounds: number): number {
    if (!Number.isSafeInteger(rounds) || rounds < 1) {
        throw new Error("TODO rounds must be a positive safe integer")
    }
    const index = TODO_ROUND_BOUNDS.findIndex((bound) => rounds <= bound)
    return index === -1 ? TODO_ROUND_BOUNDS.length : index
}

/** Violations of one attempts summary; empty when the reader would accept it. */
export function validateTaskAttempts(attempts: UsageTaskAttemptsWire): ExecutionMetricsViolation[] {
    if (!isConsistentSampleSummary(attempts, EMPTY_EXECUTION_SUMMARY)) return ["task_attempts"]
    // Every sampled value is `taskAttempt + 1`, so a non-empty sample is at least one.
    if (attempts.count > 0 && attempts.min < 1) return ["task_attempts"]
    return []
}

/**
 * Whether a fact may carry `todos` at all.
 *
 * A subagent keeps no checklist, so its absence is expected and must not be
 * reported as a coverage gap the reader should interpret as zero completions.
 */
export function roleCarriesTodos(role: string): boolean {
    return role === "task" || role === "compaction"
}

/** Whether a structure holds nothing and therefore must not be sent. */
export function isEmptyTools(tools: UsageToolsWire): boolean {
    return outcomeTotal(tools) === 0 && Object.keys(tools.by_name ?? {}).length === 0
}

export function isEmptyTodos(todos: UsageTodosWire): boolean {
    return todos.declared === 0 && todos.completed === 0 && todos.reopened === 0 && todos.abandoned === 0
}

export function isEmptyTaskAttempts(attempts: UsageTaskAttemptsWire): boolean {
    return attempts.count === 0
}
