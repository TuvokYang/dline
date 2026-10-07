import type { InternalCompactionAttemptIdentity } from "@core/context/context-management/internal-compaction-pass"
import {
	areCompactionPassIdentitiesEqual,
	type CompactionPassIdentity,
} from "@core/context/context-management/target-window-fitting"
import type { CompactionFailureKind } from "@shared/context-compaction-failure"

export type ContextCompactionAttemptIdentity = InternalCompactionAttemptIdentity
export type ContextCompactionUnitKind = "pass" | "summary_refit" | "failure"
export type ContextCompactionPresentationStatus =
	| "preparing"
	| "waiting"
	| "receiving"
	| "running"
	| "retrying"
	| "failed"
	| "completed"

export interface ContextCompactionPresentationSnapshot {
	operationId: string
	unitKind: ContextCompactionUnitKind
	unitIndex: number
	passIdentity?: CompactionPassIdentity
	attempt?: ContextCompactionAttemptIdentity
	existingTs?: number
	content: string
	status: ContextCompactionPresentationStatus
	error?: string
	/** Content-free classification of the latest failed attempt; cleared once the unit progresses again. */
	failureKind?: CompactionFailureKind
	retryAttempt?: number
	maxRetryAttempts?: number
	durable: boolean
}

interface ContextCompactionPresentationUnit extends ContextCompactionPresentationSnapshot {}

/** Own stable per-unit cards while rejecting stale Pass, refit, and attempt events. */
export class ContextCompactionPresentation {
	private readonly units = new Map<string, ContextCompactionPresentationUnit>()
	private readonly activeUnitKeys = new Map<string, string>()

	preparePass(operationId: string, passIndex: number): ContextCompactionPresentationSnapshot | undefined {
		return this.prepareUnit(operationId, "pass", passIndex)
	}

	startPass(
		passIdentity: CompactionPassIdentity,
		attempt: ContextCompactionAttemptIdentity,
	): ContextCompactionPresentationSnapshot | undefined {
		const unit = this.getOrPreparePass(passIdentity)
		if (!unit || !this.canBindIdentity(unit, passIdentity)) return undefined
		unit.passIdentity = { ...passIdentity }
		unit.attempt = { ...attempt }
		unit.status = "waiting"
		this.clearTransientFailure(unit)
		return this.snapshot(unit)
	}

	receiving(
		passIdentity: CompactionPassIdentity,
		attempt: ContextCompactionAttemptIdentity,
	): ContextCompactionPresentationSnapshot | undefined {
		return this.receiveUnit("pass", passIdentity.passIndex, passIdentity, attempt)
	}

	partial(
		passIdentity: CompactionPassIdentity,
		attempt: ContextCompactionAttemptIdentity,
		content: string,
	): ContextCompactionPresentationSnapshot | undefined {
		return this.partialUnit("pass", passIdentity.passIndex, passIdentity, attempt, content)
	}

	retry(
		passIdentity: CompactionPassIdentity,
		failedAttempt: ContextCompactionAttemptIdentity,
		nextAttempt: ContextCompactionAttemptIdentity,
		retryAttempt?: number,
		maxRetryAttempts?: number,
		error?: string,
		failureKind?: CompactionFailureKind,
	): ContextCompactionPresentationSnapshot | undefined {
		return this.retryUnit(
			"pass",
			passIdentity.passIndex,
			passIdentity,
			failedAttempt,
			nextAttempt,
			retryAttempt,
			maxRetryAttempts,
			error,
			failureKind,
		)
	}

	complete(
		passIdentity: CompactionPassIdentity,
		attempt: ContextCompactionAttemptIdentity,
		content: string,
	): ContextCompactionPresentationSnapshot | undefined {
		return this.completeUnit("pass", passIdentity.passIndex, passIdentity, attempt, content)
	}

	prepareSummaryRefit(
		passIdentity: CompactionPassIdentity,
		refitIndex: number,
	): ContextCompactionPresentationSnapshot | undefined {
		const unit = this.prepareUnit(passIdentity.operationId, "summary_refit", refitIndex)
		if (!unit || !this.canBindIdentity(unit, passIdentity)) return undefined
		const stored = this.getUnit(passIdentity.operationId, "summary_refit", refitIndex)
		if (!stored) return undefined
		stored.passIdentity = { ...passIdentity }
		return this.snapshot(stored)
	}

	startSummaryRefit(
		passIdentity: CompactionPassIdentity,
		refitIndex: number,
		attempt: ContextCompactionAttemptIdentity,
	): ContextCompactionPresentationSnapshot | undefined {
		const unit = this.getUnit(passIdentity.operationId, "summary_refit", refitIndex)
		if (!unit || !this.canBindIdentity(unit, passIdentity)) return undefined
		unit.passIdentity = { ...passIdentity }
		unit.attempt = { ...attempt }
		unit.status = "waiting"
		this.clearTransientFailure(unit)
		return this.snapshot(unit)
	}

	receivingSummaryRefit(
		passIdentity: CompactionPassIdentity,
		attempt: ContextCompactionAttemptIdentity,
	): ContextCompactionPresentationSnapshot | undefined {
		const unit = this.findCurrentIdentityUnit("summary_refit", passIdentity, attempt)
		return unit ? this.receiveUnit("summary_refit", unit.unitIndex, passIdentity, attempt) : undefined
	}

	partialSummaryRefit(
		passIdentity: CompactionPassIdentity,
		attempt: ContextCompactionAttemptIdentity,
		content: string,
	): ContextCompactionPresentationSnapshot | undefined {
		const unit = this.findCurrentIdentityUnit("summary_refit", passIdentity, attempt)
		return unit ? this.partialUnit("summary_refit", unit.unitIndex, passIdentity, attempt, content) : undefined
	}

	retrySummaryRefit(
		passIdentity: CompactionPassIdentity,
		failedAttempt: ContextCompactionAttemptIdentity,
		nextAttempt: ContextCompactionAttemptIdentity,
		retryAttempt?: number,
		maxRetryAttempts?: number,
		error?: string,
		failureKind?: CompactionFailureKind,
	): ContextCompactionPresentationSnapshot | undefined {
		const unit = this.findCurrentIdentityUnit("summary_refit", passIdentity, failedAttempt)
		return unit
			? this.retryUnit(
					"summary_refit",
					unit.unitIndex,
					passIdentity,
					failedAttempt,
					nextAttempt,
					retryAttempt,
					maxRetryAttempts,
					error,
					failureKind,
				)
			: undefined
	}

	completeSummaryRefit(
		passIdentity: CompactionPassIdentity,
		attempt: ContextCompactionAttemptIdentity,
		content: string,
	): ContextCompactionPresentationSnapshot | undefined {
		const unit = this.findCurrentIdentityUnit("summary_refit", passIdentity, attempt)
		return unit ? this.completeUnit("summary_refit", unit.unitIndex, passIdentity, attempt, content) : undefined
	}

	finalizeOperation(operationId: string): ContextCompactionPresentationSnapshot | undefined {
		const unit = [...this.units.values()]
			.filter(
				(candidate) =>
					candidate.operationId === operationId &&
					candidate.unitKind === "pass" &&
					candidate.status === "completed" &&
					!candidate.durable &&
					candidate.content.trim(),
			)
			.sort((left, right) => right.unitIndex - left.unitIndex)[0]
		return this.snapshot(unit)
	}

	fail(
		operationId: string,
		error: string,
		failureKind?: CompactionFailureKind,
	): ContextCompactionPresentationSnapshot | undefined {
		const active = this.getActiveUnit(operationId)
		if (active && active.status !== "completed" && !active.durable) {
			active.content = ""
			active.status = "failed"
			active.error = error
			active.failureKind = failureKind
			active.retryAttempt = undefined
			active.maxRetryAttempts = undefined
			return this.snapshot(active)
		}
		const unitIndex = this.nextUnitIndex(operationId, "failure")
		const failure: ContextCompactionPresentationUnit = {
			operationId,
			unitKind: "failure",
			unitIndex,
			content: "",
			status: "failed",
			error,
			...(failureKind ? { failureKind } : {}),
			durable: false,
		}
		this.storeUnit(failure)
		return this.snapshot(failure)
	}

	bindMessageTs(subject: ContextCompactionPresentationSnapshot | CompactionPassIdentity, ts: number): boolean {
		const unit = this.resolveSubject(subject)
		if (!unit || (unit.existingTs !== undefined && unit.existingTs !== ts)) return false
		unit.existingTs = ts
		return true
	}

	markDurable(subject: ContextCompactionPresentationSnapshot): boolean {
		const unit = this.resolveSubject(subject)
		if (!unit || unit.durable) return false
		unit.durable = true
		return true
	}

	clear(operationId: string): void {
		for (const [key, unit] of this.units) {
			if (unit.operationId === operationId) this.units.delete(key)
		}
		this.activeUnitKeys.delete(operationId)
	}

	getSnapshot(): ContextCompactionPresentationSnapshot | undefined {
		return this.snapshot(this.getLatestActiveUnit())
	}

	getUnitSnapshot(
		operationId: string,
		unitKind: ContextCompactionUnitKind,
		unitIndex: number,
	): ContextCompactionPresentationSnapshot | undefined {
		return this.snapshot(this.getUnit(operationId, unitKind, unitIndex))
	}

	getSnapshots(operationId: string): ContextCompactionPresentationSnapshot[] {
		return [...this.units.values()].filter((unit) => unit.operationId === operationId).map((unit) => this.cloneUnit(unit))
	}

	private prepareUnit(
		operationId: string,
		unitKind: ContextCompactionUnitKind,
		unitIndex: number,
	): ContextCompactionPresentationSnapshot | undefined {
		if (!operationId.trim() || unitIndex < 0) return undefined
		const existing = this.getUnit(operationId, unitKind, unitIndex)
		if (existing) {
			if (existing.status !== "preparing" || existing.durable) return undefined
			this.activeUnitKeys.set(operationId, this.unitKey(operationId, unitKind, unitIndex))
			return this.snapshot(existing)
		}
		const unit: ContextCompactionPresentationUnit = {
			operationId,
			unitKind,
			unitIndex,
			content: "",
			status: "preparing",
			durable: false,
		}
		this.storeUnit(unit)
		return this.snapshot(unit)
	}

	private getOrPreparePass(passIdentity: CompactionPassIdentity): ContextCompactionPresentationUnit | undefined {
		const existing = this.getUnit(passIdentity.operationId, "pass", passIdentity.passIndex)
		if (existing) return existing
		this.prepareUnit(passIdentity.operationId, "pass", passIdentity.passIndex)
		return this.getUnit(passIdentity.operationId, "pass", passIdentity.passIndex)
	}

	private receiveUnit(
		unitKind: ContextCompactionUnitKind,
		unitIndex: number,
		passIdentity: CompactionPassIdentity,
		attempt: ContextCompactionAttemptIdentity,
	): ContextCompactionPresentationSnapshot | undefined {
		const unit = this.getUnit(passIdentity.operationId, unitKind, unitIndex)
		if (!this.isCurrent(unit, passIdentity, attempt) || unit.status === "receiving") return undefined
		unit.status = "receiving"
		return this.snapshot(unit)
	}

	private partialUnit(
		unitKind: ContextCompactionUnitKind,
		unitIndex: number,
		passIdentity: CompactionPassIdentity,
		attempt: ContextCompactionAttemptIdentity,
		content: string,
	): ContextCompactionPresentationSnapshot | undefined {
		const unit = this.getUnit(passIdentity.operationId, unitKind, unitIndex)
		if (!content.trim() || !this.isCurrent(unit, passIdentity, attempt)) return undefined
		unit.content = content
		unit.status = "receiving"
		this.clearTransientFailure(unit)
		return this.snapshot(unit)
	}

	private retryUnit(
		unitKind: ContextCompactionUnitKind,
		unitIndex: number,
		passIdentity: CompactionPassIdentity,
		failedAttempt: ContextCompactionAttemptIdentity,
		nextAttempt: ContextCompactionAttemptIdentity,
		retryAttempt?: number,
		maxRetryAttempts?: number,
		error?: string,
		failureKind?: CompactionFailureKind,
	): ContextCompactionPresentationSnapshot | undefined {
		const unit = this.getUnit(passIdentity.operationId, unitKind, unitIndex)
		if (
			!this.isCurrent(unit, passIdentity, failedAttempt) ||
			nextAttempt.attemptIndex !== failedAttempt.attemptIndex + 1 ||
			!nextAttempt.authorizationAttemptId
		) {
			return undefined
		}
		unit.attempt = { ...nextAttempt }
		unit.status = "retrying"
		unit.error = error
		unit.failureKind = failureKind
		unit.retryAttempt = retryAttempt
		unit.maxRetryAttempts = maxRetryAttempts
		return this.snapshot(unit)
	}

	private completeUnit(
		unitKind: ContextCompactionUnitKind,
		unitIndex: number,
		passIdentity: CompactionPassIdentity,
		attempt: ContextCompactionAttemptIdentity,
		content: string,
	): ContextCompactionPresentationSnapshot | undefined {
		const unit = this.getUnit(passIdentity.operationId, unitKind, unitIndex)
		if (!content.trim() || !this.isCurrent(unit, passIdentity, attempt)) return undefined
		unit.content = content
		unit.status = "completed"
		this.clearTransientFailure(unit)
		return this.snapshot(unit)
	}

	private isCurrent(
		unit: ContextCompactionPresentationUnit | undefined,
		passIdentity: CompactionPassIdentity,
		attempt: ContextCompactionAttemptIdentity,
	): unit is ContextCompactionPresentationUnit {
		return (
			unit !== undefined &&
			!unit.durable &&
			unit.status !== "completed" &&
			unit.status !== "failed" &&
			unit.passIdentity !== undefined &&
			unit.attempt !== undefined &&
			areCompactionPassIdentitiesEqual(unit.passIdentity, passIdentity) &&
			unit.attempt.attemptIndex === attempt.attemptIndex &&
			unit.attempt.authorizationAttemptId === attempt.authorizationAttemptId
		)
	}

	private canBindIdentity(unit: ContextCompactionPresentationUnit, passIdentity: CompactionPassIdentity): boolean {
		return (
			!unit.durable &&
			unit.status !== "completed" &&
			unit.status !== "failed" &&
			(!unit.passIdentity || areCompactionPassIdentitiesEqual(unit.passIdentity, passIdentity))
		)
	}

	private findCurrentIdentityUnit(
		unitKind: ContextCompactionUnitKind,
		passIdentity: CompactionPassIdentity,
		attempt: ContextCompactionAttemptIdentity,
	): ContextCompactionPresentationUnit | undefined {
		return [...this.units.values()].find((unit) => unit.unitKind === unitKind && this.isCurrent(unit, passIdentity, attempt))
	}

	private clearTransientFailure(unit: ContextCompactionPresentationUnit): void {
		unit.error = undefined
		unit.failureKind = undefined
		unit.retryAttempt = undefined
		unit.maxRetryAttempts = undefined
	}

	private storeUnit(unit: ContextCompactionPresentationUnit): void {
		const key = this.unitKey(unit.operationId, unit.unitKind, unit.unitIndex)
		this.units.set(key, unit)
		this.activeUnitKeys.set(unit.operationId, key)
	}

	private getUnit(
		operationId: string,
		unitKind: ContextCompactionUnitKind,
		unitIndex: number,
	): ContextCompactionPresentationUnit | undefined {
		return this.units.get(this.unitKey(operationId, unitKind, unitIndex))
	}

	private getActiveUnit(operationId: string): ContextCompactionPresentationUnit | undefined {
		const key = this.activeUnitKeys.get(operationId)
		return key ? this.units.get(key) : undefined
	}

	private getLatestActiveUnit(): ContextCompactionPresentationUnit | undefined {
		const keys = [...this.activeUnitKeys.values()]
		return keys.length > 0 ? this.units.get(keys[keys.length - 1]) : undefined
	}

	private resolveSubject(
		subject: ContextCompactionPresentationSnapshot | CompactionPassIdentity,
	): ContextCompactionPresentationUnit | undefined {
		if ("unitKind" in subject) return this.getUnit(subject.operationId, subject.unitKind, subject.unitIndex)
		const unit = this.getUnit(subject.operationId, "pass", subject.passIndex)
		return unit?.passIdentity && areCompactionPassIdentitiesEqual(unit.passIdentity, subject) ? unit : undefined
	}

	private nextUnitIndex(operationId: string, unitKind: ContextCompactionUnitKind): number {
		let index = 0
		while (this.getUnit(operationId, unitKind, index)) index += 1
		return index
	}

	private unitKey(operationId: string, unitKind: ContextCompactionUnitKind, unitIndex: number): string {
		return `${operationId}:${unitKind}:${unitIndex}`
	}

	private snapshot(unit: ContextCompactionPresentationUnit | undefined): ContextCompactionPresentationSnapshot | undefined {
		return unit ? this.cloneUnit(unit) : undefined
	}

	private cloneUnit(unit: ContextCompactionPresentationUnit): ContextCompactionPresentationSnapshot {
		return {
			...unit,
			...(unit.passIdentity ? { passIdentity: { ...unit.passIdentity } } : {}),
			...(unit.attempt ? { attempt: { ...unit.attempt } } : {}),
		}
	}
}
