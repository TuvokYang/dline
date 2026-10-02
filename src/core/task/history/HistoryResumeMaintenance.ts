export type HistoryResumeMaintenanceStage =
	| "legacy storage cleanup"
	| "encrypted reasoning repair"
	| "interrupted activity recovery"
	| "interrupted command card recovery"
	| "task metadata refresh"
	| "context indicator refresh"

export interface HistoryResumeMaintenanceSummary {
	readonly source: "history_execution_prepare"
	readonly outcome: "clean" | "recovered" | "degraded" | "superseded"
	readonly durationMs: number
	readonly recoveredActivityCount: number
	readonly commandCardPatchAttempted: boolean
	readonly completedStageCount: number
	readonly failedStages: readonly HistoryResumeMaintenanceStage[]
}

export interface HistoryResumeMaintenancePorts {
	cleanupLegacyStorage(): Promise<void>
	/** Remove duplicated encrypted reasoning snapshots persisted by earlier versions. */
	repairEncryptedReasoning(): Promise<void>
	recoverInterruptedActivities(): Promise<Iterable<string>>
	patchInterruptedCommandCards(activityIds: ReadonlySet<string>): Promise<void>
	refreshTaskMetadata(): Promise<void>
	refreshContextIndicator(): Promise<void>
	reportFailure(stage: HistoryResumeMaintenanceStage, error: unknown): void
	reportCompletion?(summary: HistoryResumeMaintenanceSummary): void
}

type StageResult<T> = { ok: true; value: T } | { ok: false }

/** Runs best-effort historical Task maintenance outside the Resume readiness path. */
export class HistoryResumeMaintenance {
	private running?: Promise<void>

	constructor(private readonly ports: HistoryResumeMaintenancePorts) {}

	/** Coalesce concurrent requests and stop between stages when the Task loses ownership. */
	run(isCurrent: () => boolean = () => true): Promise<void> {
		if (this.running) return this.running

		const run = this.runStages(isCurrent)
			.then((summary) => this.reportCompletion(summary))
			.finally(() => {
				if (this.running === run) this.running = undefined
			})
		this.running = run
		return run
	}

	/** Settle the currently owned maintenance run before its Task resources are disposed. */
	waitForIdle(): Promise<void> {
		return this.running ?? Promise.resolve()
	}

	private async runStages(isCurrent: () => boolean): Promise<HistoryResumeMaintenanceSummary> {
		const startedAt = performance.now()
		const failedStages: HistoryResumeMaintenanceStage[] = []
		let completedStageCount = 0
		let recoveredActivityCount = 0
		let commandCardPatchAttempted = false
		let superseded = false

		const current = () => {
			if (isCurrent()) return true
			superseded = true
			return false
		}
		const runStage = async <T>(
			stage: HistoryResumeMaintenanceStage,
			operation: () => Promise<T>,
		): Promise<StageResult<T>> => {
			const result = await this.attempt(stage, operation)
			if (result.ok) completedStageCount++
			else failedStages.push(stage)
			return result
		}

		if (current()) await runStage("legacy storage cleanup", () => this.ports.cleanupLegacyStorage())

		// Repair before the metadata and context indicator stages so both observe the
		// repaired history rather than the oversized persisted one.
		if (current()) await runStage("encrypted reasoning repair", () => this.ports.repairEncryptedReasoning())

		if (current()) {
			const activities = await runStage(
				"interrupted activity recovery",
				async () => new Set(await this.ports.recoverInterruptedActivities()),
			)
			if (activities.ok) {
				recoveredActivityCount = activities.value.size
				if (current()) {
					commandCardPatchAttempted = true
					await runStage("interrupted command card recovery", () =>
						this.ports.patchInterruptedCommandCards(activities.value),
					)
				}
			}
		}

		if (current()) await runStage("task metadata refresh", () => this.ports.refreshTaskMetadata())
		if (current()) await runStage("context indicator refresh", () => this.ports.refreshContextIndicator())
		current()

		return {
			source: "history_execution_prepare",
			outcome:
				failedStages.length > 0
					? "degraded"
					: superseded
						? "superseded"
						: recoveredActivityCount > 0
							? "recovered"
							: "clean",
			durationMs: performance.now() - startedAt,
			recoveredActivityCount,
			commandCardPatchAttempted,
			completedStageCount,
			failedStages,
		}
	}

	private async attempt<T>(stage: HistoryResumeMaintenanceStage, operation: () => Promise<T>): Promise<StageResult<T>> {
		try {
			return { ok: true, value: await operation() }
		} catch (error) {
			try {
				this.ports.reportFailure(stage, error)
			} catch {
				// Diagnostics must never turn optional maintenance into a readiness failure.
			}
			return { ok: false }
		}
	}

	private reportCompletion(summary: HistoryResumeMaintenanceSummary): void {
		try {
			this.ports.reportCompletion?.(summary)
		} catch {
			// Recovery observability cannot alter optional maintenance.
		}
	}
}
