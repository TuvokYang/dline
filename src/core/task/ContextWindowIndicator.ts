import type { ContextWindowIndicatorLineage, ContextWindowIndicatorSnapshot } from "@shared/context-window-indicator"
import type { Mode } from "@shared/storage/types"

export interface CreateContextWindowIndicatorInput {
	taskId: string
	durableContextTokens: number
	environmentTokens: number
	contextWindow: number
	profileId?: string
	profileName?: string
	mode: Mode
	lineage?: ContextWindowIndicatorLineage
	updatedAt?: number
}

export interface BeginContextWindowIndicatorSendInput {
	lineage: ContextWindowIndicatorLineage
	durableContextTokens: number
	pendingSendTokens: number
	environmentTokens: number
	contextWindow: number
	profileId?: string
	profileName?: string
	mode: Mode
	updatedAt?: number
}

export interface ReceiveContextWindowIndicatorInput {
	lineage: ContextWindowIndicatorLineage
	receivingTokens: number
	/** Provider-reported total context for the in-flight request, including output and cache tokens. */
	authoritativeContextTokens?: number
	updatedAt?: number
}

export interface CommitContextWindowIndicatorInput {
	lineage: ContextWindowIndicatorLineage
	durableContextTokens: number
	pendingSendTokens?: number
	/** Adopt a smaller authoritative Durable baseline for history-replacing commits such as compaction. */
	allowDecrease?: boolean
	environmentTokens: number
	contextWindow?: number
	profileId?: string
	profileName?: string
	mode?: Mode
	updatedAt?: number
}

export interface RollbackContextWindowIndicatorInput {
	lineage: ContextWindowIndicatorLineage
	updatedAt?: number
}

export interface RebaseContextWindowIndicatorInput {
	durableContextTokens: number
	pendingSendTokens?: number
	environmentTokens: number
	contextWindow: number
	profileId?: string
	profileName?: string
	mode: Mode
	updatedAt?: number
}

export interface SettleContextWindowIndicatorInput {
	lineage: ContextWindowIndicatorLineage
	/** Provider-reported total context for the completed ordinary round, when available. */
	authoritativeContextTokens?: number
	updatedAt?: number
}

export interface FoldContextWindowIndicatorRoundInput {
	lineage: ContextWindowIndicatorLineage
	/** Provider-reported total context for the completed request, including output and cache tokens. */
	authoritativeContextTokens?: number
	updatedAt?: number
}

export interface AdoptContextWindowIndicatorScopeInput {
	contextWindow: number
	profileId?: string
	profileName?: string
	mode: Mode
	updatedAt?: number
}

export interface RefreshStableContextWindowIndicatorInput extends AdoptContextWindowIndicatorScopeInput {
	durableContextTokens?: number
	environmentTokens: number
}

export interface RefreshStagedContextWindowIndicatorInput {
	pendingInputTokens: number
	updatedAt?: number
}

interface StableContextWindowIndicatorBaseline {
	snapshot: ContextWindowIndicatorSnapshot
	completedExchangeTokens: number
	pendingInputTokens: number
}

/** Own the only mutable context-window snapshot for one Task. */
export class ContextWindowIndicator {
	private current: ContextWindowIndicatorSnapshot
	private stableBaseline: StableContextWindowIndicatorBaseline
	private completedExchangeTokens = 0
	private pendingInputTokens = 0

	constructor(input: CreateContextWindowIndicatorInput) {
		this.current = {
			taskId: input.taskId,
			revision: 0,
			epoch: 0,
			phase: "stable",
			durableContextTokens: normalizeTokens(input.durableContextTokens),
			pendingSendTokens: 0,
			receivingTokens: 0,
			stagedTokens: 0,
			environmentTokens: normalizeTokens(input.environmentTokens),
			contextWindow: normalizeTokens(input.contextWindow),
			profileId: input.profileId,
			profileName: input.profileName,
			mode: input.mode,
			updatedAt: input.updatedAt ?? Date.now(),
			lineage: input.lineage ?? { kind: "baseline" },
		}
		this.stableBaseline = this.createStableBaseline()
	}

	getSnapshot(): ContextWindowIndicatorSnapshot {
		return cloneSnapshot(this.current)
	}

	/** Adopt a committed runtime scope without changing token or lineage state. */
	adoptScope(input: AdoptContextWindowIndicatorScopeInput): ContextWindowIndicatorSnapshot {
		const contextWindow = normalizeTokens(input.contextWindow)
		if (
			this.current.contextWindow === contextWindow &&
			this.current.profileId === input.profileId &&
			this.current.profileName === input.profileName &&
			this.current.mode === input.mode
		) {
			return this.getSnapshot()
		}

		this.current = {
			...this.current,
			revision: this.current.revision + 1,
			epoch: this.current.epoch + 1,
			contextWindow,
			profileId: input.profileId,
			profileName: input.profileName,
			mode: input.mode,
			updatedAt: input.updatedAt ?? Date.now(),
		}
		this.stableBaseline = this.createStableBaseline()
		return this.getSnapshot()
	}

	/** Refresh dynamic environment occupancy and Provider scope without disturbing an active request lineage. */
	refreshStable(input: RefreshStableContextWindowIndicatorInput): ContextWindowIndicatorSnapshot {
		if (this.current.phase !== "stable") return this.getSnapshot()
		const durableContextTokens =
			input.durableContextTokens === undefined
				? this.current.durableContextTokens
				: normalizeTokens(input.durableContextTokens)
		const environmentTokens = normalizeTokens(input.environmentTokens)
		const contextWindow = normalizeTokens(input.contextWindow)
		// This refresh runs on a timer, so most calls carry the same values as
		// the last one. Advancing the revision anyway published a snapshot that
		// differed only in its timestamp, and every consumer treats a new
		// revision as a change worth rebuilding for.
		if (
			this.current.durableContextTokens === durableContextTokens &&
			this.current.environmentTokens === environmentTokens &&
			this.current.contextWindow === contextWindow &&
			this.current.profileId === input.profileId &&
			this.current.profileName === input.profileName &&
			this.current.mode === input.mode
		) {
			return this.getSnapshot()
		}
		this.current = {
			...this.current,
			revision: this.current.revision + 1,
			durableContextTokens,
			environmentTokens,
			contextWindow,
			profileId: input.profileId,
			profileName: input.profileName,
			mode: input.mode,
			updatedAt: input.updatedAt ?? Date.now(),
		}
		this.stableBaseline = this.createStableBaseline()
		return this.getSnapshot()
	}

	/** Replace only the unsent local portion of Staged while preserving the completed exchange portion. */
	refreshStaged(input: RefreshStagedContextWindowIndicatorInput): ContextWindowIndicatorSnapshot {
		if (this.current.phase !== "stable") return this.getSnapshot()
		const pendingInputTokens = normalizeTokens(input.pendingInputTokens)
		if (pendingInputTokens === this.pendingInputTokens) return this.getSnapshot()
		this.pendingInputTokens = pendingInputTokens
		this.current = {
			...this.current,
			revision: this.current.revision + 1,
			stagedTokens: this.completedExchangeTokens + this.pendingInputTokens,
			updatedAt: input.updatedAt ?? Date.now(),
		}
		this.stableBaseline = this.createStableBaseline()
		return this.getSnapshot()
	}

	beginSend(input: BeginContextWindowIndicatorSendInput): ContextWindowIndicatorSnapshot {
		const completedExchangeTokens = normalizeTokens(this.completedExchangeTokens)
		const pendingInputTokens = normalizeTokens(this.pendingInputTokens)
		const durableContextTokens = Math.max(
			normalizeTokens(input.durableContextTokens),
			this.current.durableContextTokens + completedExchangeTokens,
		)
		const pendingSendTokens = Math.max(
			pendingInputTokens,
			Math.max(0, normalizeTokens(input.pendingSendTokens) - completedExchangeTokens),
		)
		this.stableBaseline = {
			snapshot: {
				...cloneSnapshot(this.current),
				durableContextTokens,
				pendingSendTokens: 0,
				receivingTokens: 0,
				stagedTokens: pendingInputTokens,
				phase: "stable",
			},
			completedExchangeTokens: 0,
			pendingInputTokens,
		}
		this.completedExchangeTokens = 0
		this.pendingInputTokens = 0
		this.current = {
			...this.current,
			revision: this.current.revision + 1,
			epoch: this.current.epoch + 1,
			phase: "sending",
			durableContextTokens,
			pendingSendTokens,
			receivingTokens: 0,
			stagedTokens: 0,
			environmentTokens: normalizeTokens(input.environmentTokens),
			contextWindow: normalizeTokens(input.contextWindow),
			profileId: input.profileId,
			profileName: input.profileName,
			mode: input.mode,
			updatedAt: input.updatedAt ?? Date.now(),
			lineage: cloneLineage(input.lineage),
		}
		return this.getSnapshot()
	}

	receive(input: ReceiveContextWindowIndicatorInput): ContextWindowIndicatorSnapshot {
		const receivingTokens = normalizeTokens(input.receivingTokens)
		const authoritativeContextTokens = normalizeTokens(input.authoritativeContextTokens ?? 0)
		if (
			!isSameContextWindowIndicatorLineage(this.current.lineage, input.lineage) ||
			(this.current.phase !== "sending" && this.current.phase !== "receiving") ||
			(authoritativeContextTokens <= 0 && receivingTokens <= this.current.receivingTokens)
		) {
			return this.getSnapshot()
		}
		const pendingSendTokens = normalizeTokens(this.current.pendingSendTokens)
		const durableContextTokens =
			authoritativeContextTokens > 0
				? Math.min(
						this.current.durableContextTokens,
						Math.max(0, authoritativeContextTokens - this.current.environmentTokens - receivingTokens),
					)
				: this.current.durableContextTokens
		const availableCurrentInputTokens = Math.max(
			0,
			authoritativeContextTokens - durableContextTokens - this.current.environmentTokens - receivingTokens,
		)
		const stagedTokens = authoritativeContextTokens > 0 ? availableCurrentInputTokens : pendingSendTokens
		this.completedExchangeTokens = stagedTokens
		this.pendingInputTokens = 0
		this.current = {
			...this.current,
			revision: this.current.revision + 1,
			phase: "receiving",
			durableContextTokens,
			pendingSendTokens: 0,
			receivingTokens,
			stagedTokens,
			updatedAt: input.updatedAt ?? Date.now(),
		}
		return this.getSnapshot()
	}

	commit(input: CommitContextWindowIndicatorInput): ContextWindowIndicatorSnapshot {
		if (!isSameContextWindowIndicatorLineage(this.current.lineage, input.lineage)) return this.getSnapshot()
		const lineage = cloneLineage(input.lineage)
		const replacementDurableTokens = mergeDurableTokens(input.durableContextTokens, input.pendingSendTokens)
		this.current = {
			...this.current,
			revision: this.current.revision + 1,
			phase: "committing",
			durableContextTokens: input.allowDecrease
				? replacementDurableTokens
				: Math.max(this.current.durableContextTokens, replacementDurableTokens),
			pendingSendTokens: 0,
			receivingTokens: 0,
			stagedTokens: 0,
			environmentTokens: normalizeTokens(input.environmentTokens),
			contextWindow: normalizeTokens(input.contextWindow ?? this.current.contextWindow),
			profileId: input.profileId ?? this.current.profileId,
			profileName: input.profileName ?? this.current.profileName,
			mode: input.mode ?? this.current.mode,
			updatedAt: input.updatedAt ?? Date.now(),
			lineage,
		}
		this.completedExchangeTokens = 0
		this.pendingInputTokens = 0
		this.stableBaseline = this.createStableBaseline({ phase: "stable" })
		return this.getSnapshot()
	}

	rollback(input: RollbackContextWindowIndicatorInput): ContextWindowIndicatorSnapshot {
		if (!isSameContextWindowIndicatorLineage(this.current.lineage, input.lineage)) return this.getSnapshot()
		this.completedExchangeTokens = this.stableBaseline.completedExchangeTokens
		this.pendingInputTokens = this.stableBaseline.pendingInputTokens
		this.current = {
			...cloneSnapshot(this.stableBaseline.snapshot),
			revision: this.current.revision + 1,
			epoch: this.current.epoch + 1,
			phase: "rolling_back",
			updatedAt: input.updatedAt ?? Date.now(),
		}
		return this.getSnapshot()
	}

	/** Replace a derived Durable baseline without persisting recovery identity. */
	rebaseDurable(input: RebaseContextWindowIndicatorInput): ContextWindowIndicatorSnapshot {
		this.current = {
			...this.current,
			revision: this.current.revision + 1,
			epoch: this.current.epoch + 1,
			phase: "committing",
			durableContextTokens: mergeDurableTokens(input.durableContextTokens, input.pendingSendTokens),
			pendingSendTokens: 0,
			receivingTokens: 0,
			stagedTokens: 0,
			environmentTokens: normalizeTokens(input.environmentTokens),
			contextWindow: normalizeTokens(input.contextWindow),
			profileId: input.profileId,
			profileName: input.profileName,
			mode: input.mode,
			updatedAt: input.updatedAt ?? Date.now(),
			lineage: { kind: "baseline" },
		}
		this.completedExchangeTokens = 0
		this.pendingInputTokens = 0
		this.stableBaseline = this.createStableBaseline({ phase: "stable" })
		return this.getSnapshot()
	}

	/** Commit a fully completed round into Durable; ENV is never folded. */
	foldRound(input: FoldContextWindowIndicatorRoundInput): ContextWindowIndicatorSnapshot {
		if (!isSameContextWindowIndicatorLineage(this.current.lineage, input.lineage)) return this.getSnapshot()
		if (this.current.pendingSendTokens <= 0 && this.current.receivingTokens <= 0 && (this.current.stagedTokens ?? 0) <= 0) {
			return this.getSnapshot()
		}
		const authoritativeContextTokens = normalizeTokens(input.authoritativeContextTokens ?? 0)
		const durableContextTokens = Math.max(
			this.current.durableContextTokens,
			authoritativeContextTokens > 0
				? Math.max(0, authoritativeContextTokens - this.current.environmentTokens)
				: this.current.durableContextTokens +
						this.current.pendingSendTokens +
						this.current.receivingTokens +
						(this.current.stagedTokens ?? 0),
		)
		this.completedExchangeTokens = 0
		this.pendingInputTokens = 0
		this.current = {
			...this.current,
			revision: this.current.revision + 1,
			epoch: this.current.epoch + 1,
			phase: "committing",
			durableContextTokens,
			pendingSendTokens: 0,
			receivingTokens: 0,
			stagedTokens: 0,
			updatedAt: input.updatedAt ?? Date.now(),
		}
		this.stableBaseline = this.createStableBaseline({ phase: "stable" })
		return this.getSnapshot()
	}

	settle(input: SettleContextWindowIndicatorInput): ContextWindowIndicatorSnapshot {
		if (!isSameContextWindowIndicatorLineage(this.current.lineage, input.lineage) || this.current.phase === "stable") {
			return this.getSnapshot()
		}
		const authoritativeContextTokens = normalizeTokens(input.authoritativeContextTokens ?? 0)
		this.completedExchangeTokens =
			authoritativeContextTokens > 0
				? Math.max(0, authoritativeContextTokens - this.current.durableContextTokens - this.current.environmentTokens)
				: normalizeTokens(this.completedExchangeTokens + this.current.pendingSendTokens + this.current.receivingTokens)
		this.current = {
			...this.current,
			revision: this.current.revision + 1,
			phase: "stable",
			pendingSendTokens: 0,
			receivingTokens: 0,
			stagedTokens: this.completedExchangeTokens + this.pendingInputTokens,
			updatedAt: input.updatedAt ?? Date.now(),
		}
		this.stableBaseline = this.createStableBaseline()
		return this.getSnapshot()
	}

	private createStableBaseline(overrides: Partial<ContextWindowIndicatorSnapshot> = {}): StableContextWindowIndicatorBaseline {
		return {
			snapshot: { ...cloneSnapshot(this.current), ...overrides },
			completedExchangeTokens: this.completedExchangeTokens,
			pendingInputTokens: this.pendingInputTokens,
		}
	}
}

export function isSameContextWindowIndicatorLineage(
	left: ContextWindowIndicatorLineage,
	right: ContextWindowIndicatorLineage,
): boolean {
	if (left.kind !== right.kind) return false
	switch (left.kind) {
		case "baseline":
			return right.kind === "baseline"
		case "ordinary":
			return (
				right.kind === "ordinary" &&
				left.requestId === right.requestId &&
				left.requestSequence === right.requestSequence &&
				left.attemptId === right.attemptId
			)
		case "compaction_pass":
			return (
				right.kind === "compaction_pass" &&
				left.operationId === right.operationId &&
				left.passIndex === right.passIndex &&
				left.attemptIndex === right.attemptIndex &&
				left.attemptId === right.attemptId
			)
	}
}

function cloneSnapshot(snapshot: ContextWindowIndicatorSnapshot): ContextWindowIndicatorSnapshot {
	return { ...snapshot, lineage: cloneLineage(snapshot.lineage) }
}

function cloneLineage(lineage: ContextWindowIndicatorLineage): ContextWindowIndicatorLineage {
	return { ...lineage }
}

function mergeDurableTokens(durableContextTokens: number, pendingSendTokens?: number): number {
	return normalizeTokens(durableContextTokens) + normalizeTokens(pendingSendTokens ?? 0)
}

function normalizeTokens(value: number): number {
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}
