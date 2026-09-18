import type { ToolUse } from "@core/assistant-message"
import { ClineDefaultTool } from "@shared/tools"
import { describe, expect, it, vi } from "vitest"
import { LANE_DIFF_EDITOR, type ToolLane } from "../../../kernel/turn/tool-lanes"
import type { ToolPreflightAdmission } from "../ToolPreflight"
import { TurnToolScheduler } from "../TurnToolScheduler"

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((settle) => {
		resolve = settle
	})
	return { promise, resolve }
}

async function flush(): Promise<void> {
	await Promise.resolve()
	await Promise.resolve()
}

async function waitUntil(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt++) {
		if (predicate()) return
		await new Promise<void>((resolve) => setImmediate(resolve))
	}
	throw new Error("condition did not become true")
}

function tool(name: ClineDefaultTool, dlineTid: string): ToolUse {
	return {
		type: "tool_use",
		name,
		params: {},
		partial: false,
		ts: Date.now(),
		function_id: `function-${dlineTid}`,
		dline_tid: dlineTid,
	}
}

function admission(lanes: ToolLane[] = []): ToolPreflightAdmission<void> {
	return {
		outcome: "admitted",
		decision: { kind: "automatic", scope: "read_workspace", ceiling: "auto" },
		lanes,
		run: async () => undefined,
	}
}

function requireDlineTid(tool: ToolUse): string {
	if (!tool.dline_tid) throw new Error("Test tool is missing dline_tid")
	return tool.dline_tid
}

function requireAdmission(values: readonly ToolPreflightAdmission<void>[], index: number): ToolPreflightAdmission<void> {
	const value = values[index]
	if (!value) throw new Error(`Test admission is missing at index ${index}`)
	return value
}

function admissionMap(tools: readonly ToolUse[], values: readonly ToolPreflightAdmission<void>[]) {
	return new Map(tools.map((current, index) => [requireDlineTid(current), requireAdmission(values, index)]))
}

function runThroughPool(
	scheduler: TurnToolScheduler,
	tools: ToolUse[],
	admissions: ReadonlyMap<string, ToolPreflightAdmission<void>>,
	runBlock: (tool: ToolUse) => Promise<"completed" | "halt_turn" | "retry_admission">,
) {
	return scheduler.runTurn(tools, async (session) => {
		const outcomes = await Promise.all(
			tools.map((current, index) => {
				const admission = admissions.get(requireDlineTid(current))
				if (!admission) throw new Error(`Test admission is missing at index ${index}`)
				return session.submit(current, index, admission, () => runBlock(current))
			}),
		)
		return outcomes.includes("halt_turn") ? "halt_turn" : "completed"
	})
}

describe("TurnToolScheduler", () => {
	it("persists cancellation for every running and queued block", async () => {
		const cancelled: string[] = []
		const scheduler = new TurnToolScheduler({
			readConfiguredLimit: () => 1,
			isParallelToolCallingEnabled: () => true,
			onBlockCancelled: async (dlineTid) => {
				cancelled.push(dlineTid)
			},
		})
		const tools = [tool(ClineDefaultTool.FILE_READ, "a"), tool(ClineDefaultTool.FILE_READ, "b")]
		const execution = runThroughPool(
			scheduler,
			tools,
			admissionMap(tools, [admission(), admission()]),
			async () => new Promise(() => {}),
		)

		await flush()
		scheduler.cancelActiveTurn()

		await expect(execution).resolves.toBe("halt_turn")
		expect(cancelled).toEqual(["a", "b"])
	})

	it("uses Admission lanes instead of recomputing scheduler policy", async () => {
		const scheduler = new TurnToolScheduler({
			readConfiguredLimit: () => 2,
			isParallelToolCallingEnabled: () => true,
		})
		const first = deferred<"completed">()
		const second = deferred<"completed">()
		const started: string[] = []
		const tools = [tool(ClineDefaultTool.FILE_READ, "a"), tool(ClineDefaultTool.FILE_READ, "b")]
		const execution = runThroughPool(
			scheduler,
			tools,
			admissionMap(tools, [admission([LANE_DIFF_EDITOR]), admission([LANE_DIFF_EDITOR])]),
			async (current) => {
				started.push(current.dline_tid)
				return current.dline_tid === "a" ? first.promise : second.promise
			},
		)

		await flush()
		expect(started).toEqual(["a"])
		first.resolve("completed")
		await waitUntil(() => started.length === 2)
		expect(started).toEqual(["a", "b"])
		second.resolve("completed")
		await expect(execution).resolves.toBe("completed")
	})

	it("re-admits queued work when the live limit is raised", async () => {
		let limit = 1
		const scheduler = new TurnToolScheduler({
			readConfiguredLimit: () => limit,
			isParallelToolCallingEnabled: () => true,
		})
		const gates = [deferred<"completed">(), deferred<"completed">()]
		const started: string[] = []
		const tools = [tool(ClineDefaultTool.FILE_READ, "a"), tool(ClineDefaultTool.FILE_READ, "b")]
		const execution = runThroughPool(scheduler, tools, admissionMap(tools, [admission(), admission()]), async (current) => {
			started.push(current.dline_tid)
			const gate = gates[started.length - 1]
			if (!gate) throw new Error("Test gate is missing")
			return gate.promise
		})

		await flush()
		expect(started).toEqual(["a"])
		limit = 2
		scheduler.notifyLimitChanged()
		await flush()
		expect(started).toEqual(["a", "b"])
		gates.forEach((gate) => {
			gate.resolve("completed")
		})
		await expect(execution).resolves.toBe("completed")
	})

	it("keeps turn-ending fenced when earlier pooled work returns to Admission", async () => {
		const scheduler = new TurnToolScheduler({
			readConfiguredLimit: () => 1,
			isParallelToolCallingEnabled: () => true,
		})
		const tools = [tool(ClineDefaultTool.FILE_READ, "earlier"), tool(ClineDefaultTool.ATTEMPT, "ending")]
		let endingStarted = false
		await scheduler.runTurn(tools, async (session) => {
			const ending = session.submit(tools[1], 1, admission(), async () => {
				endingStarted = true
				return "completed"
			})
			await expect(session.submit(tools[0], 0, admission(), async () => "retry_admission")).resolves.toBe("retry_admission")
			await flush()
			expect(endingStarted).toBe(false)
			session.markAdmissionSettled(0)
			await expect(ending).resolves.toBe("completed")
			return "completed"
		})
	})

	it("latches turn-ending and reports every later sibling as skipped", async () => {
		const skipped = vi.fn(async (_dlineTid: string) => undefined)
		const scheduler = new TurnToolScheduler({
			readConfiguredLimit: () => 4,
			isParallelToolCallingEnabled: () => true,
			onBlockSkipped: skipped,
		})
		const ending = deferred<"completed">()
		const tools = [
			tool(ClineDefaultTool.ATTEMPT, "ending"),
			tool(ClineDefaultTool.FILE_READ, "later-a"),
			tool(ClineDefaultTool.ATTEMPT, "later-ending"),
		]
		const started: string[] = []
		const execution = runThroughPool(
			scheduler,
			tools,
			admissionMap(tools, [admission(), admission(), admission()]),
			async (current) => {
				started.push(current.dline_tid)
				return ending.promise
			},
		)

		await flush()
		expect(started).toEqual(["ending"])
		await waitUntil(() => skipped.mock.calls.length === 2)
		expect(skipped.mock.calls.map(([dlineTid]) => dlineTid)).toEqual(["later-a", "later-ending"])
		ending.resolve("completed")
		await expect(execution).resolves.toBe("completed")
	})
})
