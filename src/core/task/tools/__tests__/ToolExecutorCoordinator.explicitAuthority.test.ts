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
	return { handler, calls: () => seen.length, lastConfig: () => seen[seen.length - 1] }
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

	it("consumes the authority once, so a second call is refused before its handler runs", async () => {
		const authority = new TaskTurnAuthority()
		authority.grant("turn-1", [
			{ type: "summarize_task", source: "manual_compact_command", targetTool: ClineDefaultTool.SUMMARIZE_TASK },
		])
		const recording = recordingHandler(ClineDefaultTool.SUMMARIZE_TASK)
		const coordinator = coordinatorWith(recording.handler)
		const config = { explicitInstructions: authority.read("turn-1") } as TaskConfig

		await coordinator.execute(config, block(ClineDefaultTool.SUMMARIZE_TASK))
		const second = await coordinator.execute(config, block(ClineDefaultTool.SUMMARIZE_TASK))

		expect(recording.calls()).toBe(1)
		expect(JSON.stringify(second)).toMatch(/explicit_instruction_(already_consumed|missing)/)
	})

	// WS-013: an explicit-only tool nobody authorized is refused centrally with a
	// code the model reads back, and none of its effects run.
	it("refuses an explicit-only tool without granted authority and never runs its handler", async () => {
		const recording = recordingHandler(ClineDefaultTool.SUMMARIZE_TASK)
		const coordinator = coordinatorWith(recording.handler)

		const result = await coordinator.execute({} as TaskConfig, block(ClineDefaultTool.SUMMARIZE_TASK))

		expect(recording.calls()).toBe(0)
		expect(JSON.stringify(result)).toContain("explicit_instruction_missing")
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
