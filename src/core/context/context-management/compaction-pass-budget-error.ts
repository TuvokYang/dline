/** Measured size of a hidden compaction Pass request that the send side refused to issue. */
export interface CompactionPassBudgetMeasurement {
    estimatedInputTokens: number
    contextWindow: number
    availableRemainder: number
    estimatedTextTokens?: number
    estimatedImageTokens?: number
}

/**
 * The hidden Pass request does not fit, reported with the measurement that rejected it.
 *
 * The measurement is the recovery contract: the session narrows the next Pass range using the
 * observed size instead of reproposing the range that was just refused. A plain Error would leave
 * the planner with no reason to shrink, so an oversized estimate would deadlock compaction.
 */
export class CompactionPassBudgetError extends Error {
    readonly estimatedInputTokens: number
    readonly contextWindow: number
    readonly availableRemainder: number
    readonly estimatedTextTokens?: number
    readonly estimatedImageTokens?: number

    constructor(measurement: CompactionPassBudgetMeasurement) {
        super(formatBudgetFailure(measurement))
        this.name = "CompactionPassBudgetError"
        this.estimatedInputTokens = measurement.estimatedInputTokens
        this.contextWindow = measurement.contextWindow
        this.availableRemainder = measurement.availableRemainder
        this.estimatedTextTokens = measurement.estimatedTextTokens
        this.estimatedImageTokens = measurement.estimatedImageTokens
    }
}

export function isCompactionPassBudgetError(error: unknown): error is CompactionPassBudgetError {
    return error instanceof CompactionPassBudgetError
}

function formatBudgetFailure(measurement: CompactionPassBudgetMeasurement): string {
    const split =
        measurement.estimatedTextTokens === undefined && measurement.estimatedImageTokens === undefined
            ? ""
            : `, text ${measurement.estimatedTextTokens ?? 0}, images ${measurement.estimatedImageTokens ?? 0}`
    return (
        `Compaction summary has no available output budget: the hidden Pass request itself does not fit ` +
        `(input ${measurement.estimatedInputTokens}, window ${measurement.contextWindow}, ` +
        `available remainder ${measurement.availableRemainder}${split}).`
    )
}
