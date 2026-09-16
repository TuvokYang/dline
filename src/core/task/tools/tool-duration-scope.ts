/**
 * Active-duration accounting for one tool execution.
 *
 * A tool's wall-clock time is not a useful performance signal on its own: it
 * includes however long a human took to approve the call and however long a
 * shell command ran. Both are governed by the user or the workspace, not by
 * Dline, and a threshold that counts them would fire on a slow reviewer instead
 * of on slow code.
 *
 * A scope therefore measures elapsed time and subtracts the spans a caller
 * explicitly declares as waiting. The result is the time the tool itself spent
 * working, which is what a regression would actually move.
 */

/** Reason a span of time is not attributed to the tool itself. */
export type ToolWaitKind = "approval" | "command"

export interface ToolDurationTotals {
	/** Wall-clock time from scope start to measurement. */
	readonly elapsedMs: number
	/** Elapsed time minus every declared wait. Never negative. */
	readonly activeMs: number
	/** Time spent waiting for a user approval decision. */
	readonly approvalWaitMs: number
	/** Time spent running a command in the workspace. */
	readonly commandWaitMs: number
}

type Clock = () => number

/**
 * Track elapsed and waiting time for a single tool execution.
 *
 * Waits are allowed to nest and to overlap: a command that itself prompts for
 * approval would otherwise have the same period subtracted twice and report a
 * negative active duration. Only the outermost wait of each kind contributes,
 * and depth is tracked per kind so an approval inside a command still measures
 * the approval separately.
 */
export class ToolDurationScope {
	private readonly startedAt: number
	private readonly waitStartedAt = new Map<ToolWaitKind, number>()
	private readonly waitDepth = new Map<ToolWaitKind, number>()
	private readonly waitTotals = new Map<ToolWaitKind, number>()
	/** Closed wait spans, kept so overlapping kinds can be merged on read. */
	private readonly completedIntervals: Array<[number, number]> = []

	constructor(private readonly now: Clock = () => performance.now()) {
		this.startedAt = now()
	}

	/**
	 * Run an operation whose duration belongs to the user or the workspace.
	 *
	 * The wait is closed even when the operation throws or is cancelled, so an
	 * aborted approval cannot leave the scope reporting an open-ended wait.
	 */
	async excludeWait<T>(kind: ToolWaitKind, operation: () => Promise<T>): Promise<T> {
		this.beginWait(kind)
		try {
			return await operation()
		} finally {
			this.endWait(kind)
		}
	}

	/** Totals as of now, leaving the scope usable for further measurement. */
	read(): ToolDurationTotals {
		const at = this.now()
		const elapsedMs = at - this.startedAt
		const approvalWaitMs = this.waitedSoFar("approval", at)
		const commandWaitMs = this.waitedSoFar("command", at)
		// Subtracting each kind separately would remove a shared period twice
		// when an approval happens inside a command, understating the work that
		// followed. The union is what elapsed time actually lost to waiting. An
		// unclosed wait is still counted, so a scope read from a failure path
		// does not report the abandoned wait as active work.
		const activeMs = Math.max(0, elapsedMs - this.unionWaitedSoFar(at))
		return {
			elapsedMs: Math.round(elapsedMs),
			activeMs: Math.round(activeMs),
			approvalWaitMs: Math.round(approvalWaitMs),
			commandWaitMs: Math.round(commandWaitMs),
		}
	}

	private beginWait(kind: ToolWaitKind): void {
		const depth = this.waitDepth.get(kind) ?? 0
		this.waitDepth.set(kind, depth + 1)
		if (depth === 0) this.waitStartedAt.set(kind, this.now())
	}

	private endWait(kind: ToolWaitKind): void {
		const depth = this.waitDepth.get(kind) ?? 0
		if (depth === 0) return
		this.waitDepth.set(kind, depth - 1)
		if (depth > 1) return
		const startedAt = this.waitStartedAt.get(kind)
		this.waitStartedAt.delete(kind)
		if (startedAt === undefined) return
		const endedAt = this.now()
		this.waitTotals.set(kind, (this.waitTotals.get(kind) ?? 0) + (endedAt - startedAt))
		this.completedIntervals.push([startedAt, endedAt])
	}

	private waitedSoFar(kind: ToolWaitKind, at: number): number {
		const completed = this.waitTotals.get(kind) ?? 0
		const openedAt = this.waitStartedAt.get(kind)
		return openedAt === undefined ? completed : completed + (at - openedAt)
	}

	/** Total time covered by at least one wait, counting an overlap once. */
	private unionWaitedSoFar(at: number): number {
		const merged: Array<[number, number]> = []
		for (const [start, end] of this.waitIntervals(at).sort((left, right) => left[0] - right[0])) {
			const last = merged.at(-1)
			if (last && start <= last[1]) {
				last[1] = Math.max(last[1], end)
				continue
			}
			merged.push([start, end])
		}
		return merged.reduce((total, [start, end]) => total + (end - start), 0)
	}

	private waitIntervals(at: number): Array<[number, number]> {
		const intervals = [...this.completedIntervals]
		for (const [, openedAt] of this.waitStartedAt) intervals.push([openedAt, at])
		return intervals
	}
}
