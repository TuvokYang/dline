import { describe, expect, it, vi } from "vitest"
import type { ProviderStartCommand, TaskEvent } from "../../kernel"
import { InMemoryConversationJournal, InMemoryTaskViewPort } from "../../stores"
import { ProviderCommandExecutor, type ProviderExecutionChunk } from "./ProviderCommandExecutor"

const command: ProviderStartCommand = {
	commandId: "provider:1",
	originRevision: 2,
	generation: 0,
	type: "provider.start",
	draftRef: "draft:1",
	turnId: "turn-request",
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

async function* chunks(values: readonly ProviderExecutionChunk[]): AsyncIterable<ProviderExecutionChunk> {
	for (const value of values) yield value
}

describe("ProviderCommandExecutor", () => {
	it("projects partial data transiently and finalizes one durable journal entry", async () => {
		const recorded = recorder()
		const journal = new InMemoryConversationJournal()
		const taskView = new InMemoryTaskViewPort()
		const usage = vi.fn()
		const executor = new ProviderCommandExecutor(
			"task-1",
			{
				start: () =>
					chunks([
						{
							kind: "partial",
							transientId: "stream-1",
							payloadRef: "payload:partial",
							projection: { text: "partial" },
						},
						{
							kind: "final",
							transientId: "stream-1",
							turnId: "turn-request",
							payloadRef: "payload:final",
							turnPlan: { mode: "serial", blocks: [] },
						},
						{ kind: "usage", usage: { inputTokens: 10, outputTokens: 2 } },
					]),
				recordUsage: usage,
			},
			journal,
			taskView,
			recorded.sink,
		)
		await executor.execute(command)
		expect(taskView.transient).toEqual([{ taskId: "task-1", projection: { text: "partial" } }])
		expect(await journal.read()).toEqual([
			expect.objectContaining({ kind: "message", payloadRef: "payload:final", transientId: "stream-1" }),
		])
		expect(usage).toHaveBeenCalledWith({ inputTokens: 10, outputTokens: 2 })
		expect(recorded.events).toEqual([
			{
				type: "provider.turn_ready",
				generation: 0,
				commandId: "provider:1",
				originRevision: 2,
				turnId: "turn-request",
				finalPayloadRef: "payload:final",
				journalWatermark: { epoch: 0, seq: 1 },
				turnPlan: { mode: "serial", blocks: [] },
			},
		])
	})

	it("rejects a final chunk for another turn", async () => {
		const recorded = recorder()
		const journal = new InMemoryConversationJournal()
		const executor = new ProviderCommandExecutor(
			"task-1",
			{
				start: () =>
					chunks([
						{
							kind: "final",
							turnId: "turn-other",
							payloadRef: "payload:final",
							turnPlan: { mode: "serial", blocks: [] },
						},
					]),
			},
			journal,
			new InMemoryTaskViewPort(),
			recorded.sink,
		)
		await executor.execute(command)
		expect(await journal.read()).toEqual([])
		expect(recorded.events).toEqual([
			expect.objectContaining({
				type: "provider.failed",
				commandId: "provider:1",
				message: "provider execution failed (Error)",
			}),
		])
	})

	it("rejects content after final without publishing or finalizing the turn", async () => {
		const recorded = recorder()
		const journal = new InMemoryConversationJournal()
		const executor = new ProviderCommandExecutor(
			"task-1",
			{
				start: () =>
					chunks([
						{
							kind: "final",
							turnId: "turn-1",
							payloadRef: "payload:final",
							turnPlan: { mode: "serial", blocks: [] },
						},
						{ kind: "partial", transientId: "late", payloadRef: "payload:late" },
					]),
			},
			journal,
			new InMemoryTaskViewPort(),
			recorded.sink,
		)
		await executor.execute(command)
		expect(await journal.read()).toEqual([])
		expect(recorded.events).toEqual([
			{
				type: "provider.failed",
				generation: 0,
				commandId: "provider:1",
				originRevision: 2,
				turnId: "turn-request",
				message: "provider execution failed (Error)",
			},
		])
	})

	it("emits a sanitized provider failure when the stream has no final chunk", async () => {
		const recorded = recorder()
		const executor = new ProviderCommandExecutor(
			"task-1",
			{ start: () => chunks([]) },
			new InMemoryConversationJournal(),
			new InMemoryTaskViewPort(),
			recorded.sink,
		)
		await executor.execute(command)
		expect(recorded.events).toEqual([
			{
				type: "provider.failed",
				generation: 0,
				commandId: "provider:1",
				originRevision: 2,
				turnId: "turn-request",
				message: "provider execution failed (Error)",
			},
		])
	})

	it("cancels an active stream without reporting a provider failure", async () => {
		const recorded = recorder()
		let started!: () => void
		const ready = new Promise<void>((resolve) => (started = resolve))
		const executor = new ProviderCommandExecutor(
			"task-1",
			{
				start: ({ signal }) => ({
					async *[Symbol.asyncIterator]() {
						started()
						await new Promise<void>((_resolve, reject) =>
							signal.addEventListener(
								"abort",
								() => reject(Object.assign(new Error("cancelled"), { name: "AbortError" })),
								{ once: true },
							),
						)
					},
				}),
			},
			new InMemoryConversationJournal(),
			new InMemoryTaskViewPort(),
			recorded.sink,
		)
		const execution = executor.execute(command)
		await ready
		expect(executor.cancel(command.commandId)).toBe(true)
		await execution
		expect(recorded.events).toEqual([])
	})
})
