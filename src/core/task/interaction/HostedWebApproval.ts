/** Build the obsolete identity retained only for persisted snapshot migration. */
export function hostedWebApprovalId(taskId: string, apiIndex: number): string {
	return `hosted-web:${taskId}:${apiIndex}`
}

/** Parse the durable request index only from this task's exact Hosted approval identity. */
export function hostedWebApprovalApiIndex(taskId: string, interactionId: string): number | undefined {
	const prefix = `hosted-web:${taskId}:`
	if (!interactionId.startsWith(prefix)) return undefined
	const rawIndex = interactionId.slice(prefix.length)
	if (!/^(0|[1-9]\d*)$/.test(rawIndex)) return undefined
	const apiIndex = Number(rawIndex)
	return Number.isSafeInteger(apiIndex) ? apiIndex : undefined
}
