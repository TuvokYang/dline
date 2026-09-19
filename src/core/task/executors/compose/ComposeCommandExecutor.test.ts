import { describe, expect, it, vi } from "vitest"
import type { ComposeRoundCommand, TaskEvent } from "../../kernel"
import { ComposeCommandExecutor } from "./ComposeCommandExecutor"

const command: ComposeRoundCommand = {
	commandId: "compose:1",
	originRevision: 1,
	generation: 0,
	type: "compose.round",
	turnId: "turn-1",
	admittedEntryIds: ["entry-1"],
}

function recorder() {
	const events: TaskEvent[] = []
	return {
		events,
		sink: {
			submit: vi.fn(async (event: TaskEvent) => {
				events.push(event)
				return { kind: "accepted" as const }
			}),
		},
	}
}

describe("ComposeCommandExecutor", () => {
	it("emits compose.completed with only the durable draft reference", async () => {
		const recorded = recorder()
		const compose = vi.fn(async () => ({ draftRef: "draft:1" }))
		await new ComposeCommandExecutor({ compose }, recorded.sink).execute(command)
		expect(compose).toHaveBeenCalledWith({ turnId: "turn-1", admittedEntryIds: ["entry-1"], signal: expect.any(AbortSignal) })
		expect(recorded.events).toEqual([
			{
				type: "compose.completed",
				generation: 0,
				commandId: "compose:1",
				originRevision: 1,
				turnId: "turn-1",
				draftRef: "draft:1",
			},
		])
	})

	it("emits a sanitized failure event", async () => {
		const recorded = recorder()
		const executor = new ComposeCommandExecutor(
			{ compose: vi.fn(async () => Promise.reject(new Error("secret-token"))) },
			recorded.sink,
		)
		await executor.execute(command)
		expect(recorded.events).toEqual([
			{
				type: "compose.failed",
				generation: 0,
				commandId: "compose:1",
				originRevision: 1,
				turnId: "turn-1",
				message: "compose execution failed (Error)",
			},
		])
		expect(JSON.stringify(recorded.events)).not.toContain("secret-token")
	})

	it("cancels without emitting a business failure", async () => {
		const recorded = recorder()
		let started!: () => void
		const ready = new Promise<void>((resolve) => (started = resolve))
		const executor = new ComposeCommandExecutor(
			{
				compose: async ({ signal }) => {
					started()
					await new Promise<void>((_resolve, reject) =>
						signal.addEventListener(
							"abort",
							() => reject(Object.assign(new Error("cancelled"), { name: "AbortError" })),
							{ once: true },
						),
					)
					return { draftRef: "unreachable" }
				},
			},
			recorded.sink,
		)
		const execution = executor.execute(command)
		await ready
		expect(executor.cancel(command.commandId)).toBe(true)
		await execution
		expect(recorded.events).toEqual([])
	})
})
