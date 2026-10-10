/** Legacy presentation phases retained only while older turn content is reconstructed. */
export enum BlockPhase {
    STREAMING = "streaming",
    AWAITING_APPROVAL = "awaiting_approval",
    EXECUTING = "executing",
    AUTO_EXECUTING = "auto_executing",
    COMPLETED = "completed",
    REJECTED = "rejected",
    SKIPPED = "skipped",
    CANCELLED = "cancelled",
}

/** Read-only compatibility record consumed by resume and mistake-limit assembly. */
export interface BlockLifecycle {
    dlineTid: string
    functionId: string
    toolName: string
    phase: BlockPhase
    ts: number
    requiresApproval: boolean
    conversationHistoryIndex: number
}
