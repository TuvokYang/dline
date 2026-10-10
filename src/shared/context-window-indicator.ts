import type { Mode } from "./storage/types"

export type ContextWindowIndicatorPhase = "stable" | "sending" | "receiving" | "committing" | "rolling_back"

export type ContextWindowIndicatorLineage =
    | { kind: "baseline" }
    | {
          kind: "ordinary"
          requestId: string
          requestSequence: number
          attemptId: string
      }
    | {
          kind: "compaction_pass"
          operationId: string
          passIndex: number
          attemptIndex: number
          attemptId: string
      }

/** Authoritative Task-local context-window state consumed by Extension state and the Task Header. */
export interface ContextWindowIndicatorSnapshot {
    taskId: string
    revision: number
    epoch: number
    phase: ContextWindowIndicatorPhase
    durableContextTokens: number
    pendingSendTokens: number
    receivingTokens: number
    /** Request-complete and pending local content not yet committed to the durable request baseline. */
    stagedTokens?: number
    environmentTokens: number
    contextWindow: number
    profileId?: string
    profileName?: string
    mode: Mode
    updatedAt: number
    lineage: ContextWindowIndicatorLineage
}

/** Compatibility total for clients that have not migrated to the segmented indicator. */
export function getContextWindowIndicatorTotalTokens(snapshot: ContextWindowIndicatorSnapshot): number {
    return (
        snapshot.durableContextTokens +
        snapshot.pendingSendTokens +
        snapshot.receivingTokens +
        (snapshot.stagedTokens ?? 0) +
        snapshot.environmentTokens
    )
}
