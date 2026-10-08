/**
 * The interaction id of a tool call's approval, derived from the call's stable id.
 *
 * The approval row in the chat carries this id, so every consumer that has to
 * find that row again (the executor resolving the answer, a handler marking a
 * refused call) must derive it the same way.
 */
export function approvalInteractionId(dlineTid: string): string {
	return `approval:${dlineTid}`
}

/**
 * Whether a chat row is the approval row of the given tool call.
 *
 * Rows written before approvals had their own id carried the bare call id,
 * and a restored task can still show them.
 */
export function isApprovalRowOf(rowInteractionId: string | undefined, dlineTid: string): boolean {
	return rowInteractionId === approvalInteractionId(dlineTid) || rowInteractionId === dlineTid
}
