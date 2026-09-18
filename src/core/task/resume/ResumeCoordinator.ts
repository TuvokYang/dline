import type { ResumeInput, ResumeResult } from "./ResumeInput"
import { reconcileResume } from "./ResumeReconciler"

/** Infrastructure boundary for deterministic, stopped history hydration. */
export interface ResumeCoordinatorPorts {
	load(taskId: string): Promise<ResumeInput>
	/** Persist a real ask row for a synthesized stopped interaction before hydration. */
	presentInteraction(result: ResumeResult): Promise<void>
	persist(result: ResumeResult): Promise<void>
	reportPersistenceFailure?(error: unknown, result: ResumeResult): void
	hydrate(result: ResumeResult): Promise<void>
	publishView(result: ResumeResult): Promise<void>
}

/** Reconciles persisted state without ever dispatching API or tool work. */
export class ResumeCoordinator {
	private readonly preparingByTaskId = new Map<string, Promise<ResumeResult>>()

	constructor(private readonly ports: ResumeCoordinatorPorts) {}

	/** Reconcile, persist and publish a stopped historical task. */
	prepare(taskId: string): Promise<ResumeResult> {
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
		const input = await this.ports.load(taskId)
		const result = reconcileResume(input)

		// Both writes are synchronously registered before publishing. A response accepted
		// immediately after the view appears therefore queues its UI row behind the recovered
		// ask and its newer snapshot behind the recovered snapshot, without waiting for slow
		// Windows file locks before enabling the footer.
		const interactionPersistence = this.ports.presentInteraction(result)
		const snapshotPersistence = this.ports.persist(result)
		const persistence = Promise.all([interactionPersistence, snapshotPersistence])
			.then(() => undefined)
			.catch((error) => {
				try {
					this.ports.reportPersistenceFailure?.(error, result)
				} catch {
					// Diagnostics cannot turn a reconstructable history projection into a readiness failure.
				}
			})
		try {
			await this.ports.hydrate(result)
			await this.ports.publishView(result)
		} catch (error) {
			await persistence
			throw error
		}
		await persistence
		return result
	}
}
