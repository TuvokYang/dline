import type { ToolUse } from "@core/assistant-message"
import { ClineDefaultTool } from "@shared/tools"
import { describe, expect, it } from "vitest"
import { TaskTurnAuthority } from "../../explicit-instructions/TurnAuthority"
import type { IToolHandler } from "../ToolExecutorCoordinator"
import { ToolExecutorCoordinator } from "../ToolExecutorCoordinator"
import type { TaskConfig } from "../types/TaskConfig"

function block(name: ClineDefaultTool): ToolUse {
	return { type: "tool_use", name, params: {}, partial: false } as ToolUse
}

function recordingHandler(name: ClineDefaultTool) {
	const seen: TaskConfig[] = []
	const handler: IToolHandler = {
		name,
		getDescription: () => `[${name}]`,
		execute: async (config: TaskConfig) => {
			seen.push(config)
			return "done"
		},
	}
	return { handler, lastConfig: () => seen[seen.length - 1] }
}

function coordinatorWith(handler: IToolHandler): ToolExecutorCoordinator {
	const coordinator = new ToolExecutorCoordinator()
	coordinator.register(handler)
	return coordinator
}

describe("ToolExecutorCoordinator explicit authority", () => {
	it("hands the handler one consumed authorization when the turn granted it", async () => {
		const authority = new TaskTurnAuthority()
		authority.grant("turn-1", [
			{ type: "summarize_task", source: "manual_compact_command", targetTool: ClineDefaultTool.SUMMARIZE_TASK },
		])
		const recording = recordingHandler(ClineDefaultTool.SUMMARIZE_TASK)
		const coordinator = coordinatorWith(recording.handler)
		const config = { explicitInstructions: authority.read("turn-1") } as TaskConfig

		await coordinator.execute(config, block(ClineDefaultTool.SUMMARIZE_TASK))

		expect(recording.lastConfig().explicitInstructionAuthorization).toMatchObject({
			type: "summarize_task",
			targetTool: ClineDefaultTool.SUMMARIZE_TASK,
			state: "consumed",
		})
	})

	it("consumes the authority once, so a second call carries none", async () => {
		const authority = new TaskTurnAuthority()
		authority.grant("turn-1", [
			{ type: "summarize_task", source: "manual_compact_command", targetTool: ClineDefaultTool.SUMMARIZE_TASK },
		])
		const recording = recordingHandler(ClineDefaultTool.SUMMARIZE_TASK)
		const coordinator = coordinatorWith(recording.handler)
		const config = { explicitInstructions: authority.read("turn-1") } as TaskConfig

		await coordinator.execute(config, block(ClineDefaultTool.SUMMARIZE_TASK))
		await coordinator.execute(config, block(ClineDefaultTool.SUMMARIZE_TASK))

		expect(recording.lastConfig().explicitInstructionAuthorization).toBeUndefined()
	})

	it("leaves a tool without granted authority to its own refusal", async () => {
		const recording = recordingHandler(ClineDefaultTool.SUMMARIZE_TASK)
		const coordinator = coordinatorWith(recording.handler)

		await coordinator.execute({} as TaskConfig, block(ClineDefaultTool.SUMMARIZE_TASK))

		expect(recording.lastConfig().explicitInstructionAuthorization).toBeUndefined()
	})

	it("does not touch a tool that needs no explicit authority", async () => {
		const authority = new TaskTurnAuthority()
		authority.grant("turn-1", [
			{ type: "summarize_task", source: "manual_compact_command", targetTool: ClineDefaultTool.SUMMARIZE_TASK },
		])
		const recording = recordingHandler(ClineDefaultTool.FILE_READ)
		const coordinator = coordinatorWith(recording.handler)
		const config = { explicitInstructions: authority.read("turn-1") } as TaskConfig

		await coordinator.execute(config, block(ClineDefaultTool.FILE_READ))

		expect(recording.lastConfig().explicitInstructionAuthorization).toBeUndefined()
		expect(authority.read("turn-1")?.getPendingToolAuthorization(ClineDefaultTool.SUMMARIZE_TASK)).toBeDefined()
	})
})
