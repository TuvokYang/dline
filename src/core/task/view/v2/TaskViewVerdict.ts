import type { DialogInteraction, TaskState } from "../../kernel/types"

export type TaskTerminalVerdict = "active" | "completed" | "error" | "consumed" | "terminated"
export type TaskInputVerdict = "enabled" | "interaction" | "halting" | "disabled"

export interface TaskViewVerdict {
	readonly taskId: string
	readonly revision: number
	readonly generation: number
	readonly phase: TaskState["flow"]["phase"]
	readonly terminal: TaskTerminalVerdict
	readonly input: TaskInputVerdict
	readonly activeInteraction?: Pick<DialogInteraction, "interactionId" | "kind" | "status" | "createdRevision">
	readonly canResume: boolean
	readonly canComplete: boolean
}

function terminalVerdict(state: TaskState): TaskTerminalVerdict {
	if (state.flow.terminalReason === "consumed") return "consumed"
	if (state.flow.phase === "completed") return "completed"
	if (state.flow.phase === "error") return "error"
	if (state.flow.phase === "terminated") return "terminated"
	return "active"
}

function inputVerdict(state: TaskState, terminal: TaskTerminalVerdict): TaskInputVerdict {
	if (state.halt.status === "stopping") return "halting"
	if (terminal === "consumed" || terminal === "terminated") return "disabled"
	if (state.dialog.primary?.status === "awaiting") return "interaction"
	return "enabled"
}

export function projectTaskViewVerdict(state: TaskState): TaskViewVerdict {
	const terminal = terminalVerdict(state)
	const activeInteraction = state.dialog.primary
		? {
				interactionId: state.dialog.primary.interactionId,
				kind: state.dialog.primary.kind,
				status: state.dialog.primary.status,
				createdRevision: state.dialog.primary.createdRevision,
			}
		: undefined
	return {
		taskId: state.taskId,
		revision: state.revision,
		generation: state.generation,
		phase: state.flow.phase,
		terminal,
		input: inputVerdict(state, terminal),
		activeInteraction,
		canResume: state.flow.phase === "paused" && terminal === "active",
		canComplete: terminal === "completed" && state.dialog.primary?.kind === "completion",
	}
}
