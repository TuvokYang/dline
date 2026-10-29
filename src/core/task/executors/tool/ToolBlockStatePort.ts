export interface ToolBlockStatePort {
    wasRejected?(blockId: string): boolean
    isAwaitingApproval?(blockId: string): boolean
    rejectActiveBlock?(): unknown
    reset?(): void
    hasAnyRejection?(): boolean
}
