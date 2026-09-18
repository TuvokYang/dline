import type { ToolRunCommand } from "./ToolExecutionDomain"

/** Runtime EXECUTE_TOOL effect shape consumed by the tool domain adapter. */
export interface ToolExecutionEffect {
	id: string
	turnId?: string
	dlineTid: string
	mode?: "serial" | "parallel"
}

export interface ToolEffectDispatcherPorts {
	track(commandId: string): Promise<void>
	dispatch(command: ToolRunCommand): void
}

/**
 * Resolve the canonical block and dispatch one correlated command to the tool domain.
 *
 * Keeping lookup and command construction together prevents the Task effect port
 * from rebuilding execution semantics around the extracted domain.
 */
export async function dispatchToolExecutionEffect(effect: ToolExecutionEffect, ports: ToolEffectDispatcherPorts): Promise<void> {
	const commandId = `${effect.id}:${effect.dlineTid}`
	const settled = ports.track(commandId)
	ports.dispatch({
		commandId,
		turnId: effect.turnId,
		dlineTid: effect.dlineTid,
		mode: effect.mode,
	})
	await settled
}
