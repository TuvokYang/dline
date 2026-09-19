import { describe, expect, it, vi } from "vitest"
import type { TaskEvent, ToolRunCommand } from "../../../kernel"
import { ToolCommandExecutor } from "../ToolCommandExecutor"
import { createDeniedSurface } from "../ToolDomainSurface"
import type { ToolRunCommand as DomainToolRunCommand, ToolDomainRunner } from "../ToolExecutionDomain"

function command(): ToolRunCommand {
	return {
		commandId: "tool-command-1",
		originRevision: 1,
		generation: 0,
		type: "tool.run",
		turnId: "turn-1",
		mode: "parallel",
		blocks: [
			{ blockId: "b1", attempt: "a1", index: 0, lanes: ["fs"], turnEnding: false },
			{ blockId: "b2", attempt: "a2", index: 1, lanes: ["net"], turnEnding: false },
		],
	}
}

function harness() {
	const settlers = new Map<string, { resolve(): void; reject(error: Error): void }>()
	const runner: ToolDomainRunner = {
		runBlock: vi.fn(
			(input: DomainToolRunCommand) =>
				new Promise<void>((resolve, reject) => settlers.set(input.dlineTid, { resolve, reject })),
		),
		release: vi.fn(async () => undefined),
	}
	const events: TaskEvent[] = []
	const executor = new ToolCommandExecutor(
		{ runner, surface: createDeniedSurface("detached_domain") },
		{ submit: async (event) => (events.push(event), { kind: "accepted" as const }) },
	)
	return { executor, runner, settlers, events }
}

describe("ToolCommandExecutor", () => {
	it("reuses the tool domain while preserving per-block identity under out-of-order completion", async () => {
		const { executor, runner, settlers, events } = harness()
		const completion = executor.execute(command())
		await vi.waitFor(() => expect(runner.runBlock).toHaveBeenCalledTimes(2))
		settlers.get("b2")?.resolve()
		await vi.waitFor(() =>
			expect(events.some((event) => event.type === "tool.completed" && event.blockId === "b2")).toBe(true),
		)
		settlers.get("b1")?.resolve()
		await completion

		type KernelToolEvent = Extract<TaskEvent, { type: "tool.started" | "tool.completed" | "tool.failed" | "tool.cancelled" }>
		const toolEvents = events.filter((event): event is KernelToolEvent => event.type.startsWith("tool."))
		expect(toolEvents.filter((event) => event.type === "tool.started").map((event) => event.blockId)).toEqual(["b1", "b2"])
		expect(toolEvents.filter((event) => event.type === "tool.completed").map((event) => event.blockId)).toEqual(["b2", "b1"])
		expect(runner.runBlock).toHaveBeenCalledWith(expect.objectContaining({ dlineTid: "b1", mode: "parallel" }))
	})

	it("keeps the halt fence until explicit rearm and converts pre-halt work to cancellation", async () => {
		const { executor, runner, settlers, events } = harness()
		const execution = executor.execute({ ...command(), blocks: [command().blocks[0]] })
		await vi.waitFor(() => expect(runner.runBlock).toHaveBeenCalledTimes(1))
		const order = { haltId: "halt-1", generation: 0, reason: "cancel" as const }
		executor.fence(order)
		const stopping = executor.stop(order)
		settlers.get("b1")?.resolve()
		await stopping
		await executor.drain(order)
		await execution

		expect(events.some((event) => event.type === "tool.cancelled" && event.blockId === "b1")).toBe(true)
		expect(events.some((event) => event.type === "tool.completed" && event.blockId === "b1")).toBe(false)
		expect(runner.release).toHaveBeenCalledTimes(1)
		executor.rearm("halt-older")
		await executor.execute({ ...command(), commandId: "fenced", blocks: [] })
		executor.rearm("halt-1")
	})
})
