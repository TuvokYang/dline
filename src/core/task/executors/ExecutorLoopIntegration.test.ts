import { describe, expect, it, vi } from "vitest"
import { createInitialTaskState } from "../kernel"
import { TaskRuntimeV2 } from "../runtime/v2"
import { InMemoryCommandPublicationStore, InMemoryConversationJournal, InMemoryStateVault, InMemoryTaskViewPort } from "../stores"
import { CompactionCommandExecutor } from "./compaction"
import { ComposeCommandExecutor } from "./compose"
import { ProviderCommandExecutor } from "./provider"

describe("executor loop integration", () => {
	it("runs two compose to provider rounds through TaskRuntimeV2", async () => {
		const vault = new InMemoryStateVault()
		const taskView = new InMemoryTaskViewPort()
		const journal = new InMemoryConversationJournal()
		const compose = vi.fn(async ({ admittedEntryIds }) => ({ draftRef: `draft:${admittedEntryIds.join(",")}` }))
		let turn = 0
		let runtime!: TaskRuntimeV2
		const events = { submit: (event: Parameters<TaskRuntimeV2["submit"]>[0]) => runtime.submit(event) }
		const provider = vi.fn(({ draftRef }: { draftRef: string }) => ({
			async *[Symbol.asyncIterator]() {
				turn += 1
				yield { kind: "final" as const, turnId: `turn-${turn}`, payloadRef: `answer:${draftRef}` }
			},
		}))
		runtime = new TaskRuntimeV2({
			initialState: createInitialTaskState("task-1"),
			vault,
			taskView,
			publications: new InMemoryCommandPublicationStore(),
			executors: [
				new ComposeCommandExecutor({ compose }, events),
				new ProviderCommandExecutor("task-1", { start: provider }, journal, taskView, events),
			],
		})

		await runtime.submit({ type: "user.submit", generation: 0, entryId: "entry-1", payloadRef: "input:1" })
		await runtime.waitForQuiescence()
		await runtime.submit({ type: "user.submit", generation: 0, entryId: "entry-2", payloadRef: "input:2" })
		await runtime.waitForQuiescence()

		expect(compose).toHaveBeenCalledTimes(2)
		expect(provider).toHaveBeenCalledTimes(2)
		expect(await journal.read()).toHaveLength(2)
		expect(runtime.getState().flow.phase).toBe("running")
	})

	it("runs an attempt-scoped compaction command through TaskRuntimeV2", async () => {
		let runtime!: TaskRuntimeV2
		const events = { submit: (event: Parameters<TaskRuntimeV2["submit"]>[0]) => runtime.submit(event) }
		runtime = new TaskRuntimeV2({
			initialState: createInitialTaskState("task-1"),
			vault: new InMemoryStateVault(),
			taskView: new InMemoryTaskViewPort(),
			publications: new InMemoryCommandPublicationStore(),
			executors: [new CompactionCommandExecutor({ run: vi.fn(async () => ({ resultRef: "summary:1" })) }, events)],
		})
		await runtime.submit({
			type: "compaction.requested",
			generation: 0,
			compactionId: "compact-1",
			attempt: "attempt-1",
			contextRef: "auto:ctx",
		})
		await runtime.waitForQuiescence()
		expect(runtime.getState().flow.compaction).toMatchObject({ status: "completed", resultRef: "summary:1" })
	})
})
