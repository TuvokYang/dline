import type { ResumeInput, ResumeRecoverySummary, ResumeResult } from "./ResumeInput"
import { reconcileResume } from "./ResumeReconciler"

/** Infrastructure boundary for deterministic, stopped history hydration. */
export interface ResumeCoordinatorPorts {
	load(taskId: string): Promise<ResumeInput>
	/** Persist a real ask row for a synthesized stopped interaction before hydration. */
	presentInteraction(result: ResumeResult): Promise<void>
	persist(result: ResumeResult): Promise<void>
	reportPersistenceFailure?(error: unknown, result: ResumeResult): void
	reportRecovery?(summary: ResumeRecoverySummary): void
	hydrate(result: ResumeResult): Promise<void>
	publishView(result: ResumeResult): Promise<void>
}

class ResumePreparationSupersededError extends Error {
	constructor() {
		super("History preparation was superseded")
		this.name = "ResumePreparationSupersededError"
	}
}

/** Reconciles persisted state without ever dispatching API or tool work. */
export class ResumeCoordinator {
	private readonly preparingByTaskId = new Map<string, Promise<ResumeResult>>()
	private fenced = false

	constructor(private readonly ports: ResumeCoordinatorPorts) {}

	/** Prevent new history preparation and fence publication from current work. */
	fence(): void {
		this.fenced = true
	}

	/** Wait until every history preparation admitted before the fence settles. */
	async waitForIdle(): Promise<void> {
		await Promise.allSettled([...this.preparingByTaskId.values()])
	}

	/** Reconcile, persist and publish a stopped historical task. */
	prepare(taskId: string): Promise<ResumeResult> {
		if (this.fenced) return Promise.reject(new ResumePreparationSupersededError())
		const preparing = this.preparingByTaskId.get(taskId)
		if (preparing) return preparing

		const transaction = this.runPreparation(taskId).finally(() => {
			if (this.preparingByTaskId.get(taskId) === transaction) {
				this.preparingByTaskId.delete(taskId)
			}
		})
		this.preparingByTaskId.set(taskId, transaction)
		return transaction
	}

	/** Load and reconcile once, then expose only the stopped projection. */
	private async runPreparation(taskId: string): Promise<ResumeResult> {
		const startedAt = performance.now()
		let input: ResumeInput
		try {
			input = await this.ports.load(taskId)
		} catch (error) {
			this.reportRecovery({
				source: "history_open",
				outcome: "failed",
				failureStage: "load",
				durationMs: performance.now() - startedAt,
				diagnosticCodes: [],
				persistenceFailed: false,
			})
			throw error
		}
		this.assertCurrent()

		let result: ResumeResult
		try {
			result = reconcileResume(input)
		} catch (error) {
			this.reportRecovery({
				source: "history_open",
				outcome: "failed",
				failureStage: "reconcile",
				durationMs: performance.now() - startedAt,
				diagnosticCodes: [],
				persistenceFailed: false,
			})
			throw error
		}
		this.assertCurrent()

		let persistenceFailed = false
		const startWrite = (operation: () => Promise<void>): Promise<void> => {
			try {
				return operation()
			} catch (error) {
				return Promise.reject(error)
			}
		}
		// Both writes are synchronously registered before hydration. allSettled keeps
		// the transaction open until both stores finish even when one fails immediately.
		const interactionPersistence = startWrite(() => this.ports.presentInteraction(result))
		const snapshotPersistence = startWrite(() => this.ports.persist(result))
		const persistence = Promise.allSettled([interactionPersistence, snapshotPersistence]).then((settled) => {
			for (const write of settled) {
				if (write.status !== "rejected") continue
				persistenceFailed = true
				try {
					this.ports.reportPersistenceFailure?.(write.reason, result)
				} catch {
					// Diagnostics cannot turn a reconstructable history projection into a readiness failure.
				}
			}
		})

		try {
			this.assertCurrent()
			await this.ports.hydrate(result)
			this.assertCurrent()
		} catch (error) {
			await persistence
			if (this.fenced || error instanceof ResumePreparationSupersededError) throw new ResumePreparationSupersededError()
			this.reportRecovery({
				source: "history_open",
				outcome: "failed",
				entryType: result.entry.type,
				failureStage: "hydrate",
				durationMs: performance.now() - startedAt,
				diagnosticCodes: result.diagnostics.map((diagnostic) => diagnostic.code),
				persistenceFailed,
			})
			throw error
		}

		try {
			this.assertCurrent()
			await this.ports.publishView(result)
			this.assertCurrent()
		} catch (error) {
			await persistence
			if (this.fenced || error instanceof ResumePreparationSupersededError) throw new ResumePreparationSupersededError()
			this.reportRecovery({
				source: "history_open",
				outcome: "failed",
				entryType: result.entry.type,
				failureStage: "publish",
				durationMs: performance.now() - startedAt,
				diagnosticCodes: result.diagnostics.map((diagnostic) => diagnostic.code),
				persistenceFailed,
			})
			throw error
		}

		await persistence
		this.reportRecovery({
			source: "history_open",
			outcome: result.diagnostics.some((diagnostic) => diagnostic.code === "snapshot_rebuilt")
				? "rebuilt"
				: result.diagnostics.length > 0 || persistenceFailed
					? "degraded"
					: "clean",
			entryType: result.entry.type,
			durationMs: performance.now() - startedAt,
			diagnosticCodes: result.diagnostics.map((diagnostic) => diagnostic.code),
			persistenceFailed,
		})
		return result
	}

	private assertCurrent(): void {
		if (this.fenced) throw new ResumePreparationSupersededError()
	}

	private reportRecovery(summary: ResumeRecoverySummary): void {
		try {
			this.ports.reportRecovery?.(summary)
		} catch {
			// Recovery observability cannot alter a reconstructable history result.
		}
	}
}
