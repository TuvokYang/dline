import { describe, expect, it } from "vitest"
import { replayDurableToolResult } from "../../../../DurableToolResult"
import type { ToolInvocationEnvelope } from "../../../../stores/payload/TaskPayloadEnvelopes"
import type { TaskConfig } from "../../../../tools/types/TaskConfig"
import { createDeniedSurface } from "../../ToolDomainSurface"
import { DefaultProductionToolExecutionService } from "../DefaultProductionToolExecutionService"
import type { ProductionToolHandlerRuntime } from "../ProductionToolHandlerRuntime"

const REFUSAL = "Explicit-only tool 'summarize_task' was rejected: explicit_instruction_missing."

const INVOCATION: ToolInvocationEnvelope = {
	kind: "tool_invocation",
	toolName: "summarize_task",
	input: { context: "SECRET_SUMMARY" },
	functionId: "dline_function_01",
	dlineTid: "dline_tid_01",
	presentationId: 1,
	isNativeToolCall: false,
}

/** A handler runtime whose gate refuses every call, as the central explicit-only gate does. */
function refusingRuntime(): ProductionToolHandlerRuntime {
	return {
		coordinator: {},
		execute: async () => REFUSAL,
		restoreSubagentRetry: async () => false,
	} as unknown as ProductionToolHandlerRuntime
}

async function execute(invocation: ToolInvocationEnvelope): Promise<string> {
	const service = new DefaultProductionToolExecutionService({
		config: { create: () => ({}) as TaskConfig },
		runtime: refusingRuntime(),
	})
	const result = await service.execute({
		command: { commandId: "command-1", turnId: "turn-1", dlineTid: invocation.dlineTid, invocationRef: "ref-1" },
		invocation,
		surface: createDeniedSurface("detached_domain"),
	})
	return result.content
}

describe("DefaultProductionToolExecutionService", () => {
	// The provider boundary kept this call in history as the markup the model
	// wrote, so the refusal must reach the model as prose rather than as a result
	// paired with a call id the provider never issued.
	it("persists the result of a call that was never recorded so it replays as prose", async () => {
		const content = await execute({ ...INVOCATION, resultReplay: "text" })

		expect(replayDurableToolResult(content)).toEqual([{ type: "text", text: `[summarize_task] Result:\n${REFUSAL}` }])
	})

	it("persists the result of a recorded call as a result paired with that call", async () => {
		const content = await execute(INVOCATION)

		expect(replayDurableToolResult(content)).toEqual([
			{
				type: "tool_result",
				function_id: "dline_function_01",
				dline_tid: "dline_tid_01",
				content: REFUSAL,
			},
		])
	})
})
