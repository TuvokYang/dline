import { describe, expect, it } from "vitest"
import { createDeniedSurface } from "../executors/tool/ToolDomainSurface"
import { TurnToolScheduler } from "../executors/tool/TurnToolScheduler"
import { createInitialTaskState } from "../kernel"
import { ALL_HALT_PARTICIPANTS } from "../kernel/machines/halt"
import { InMemoryCommandPublicationStore, InMemoryConversationJournal, InMemoryStateVault, InMemoryTaskViewPort } from "../stores"
import { createTaskExecutorAssembly } from "./TaskExecutorAssembly"
import { TaskShell } from "./TaskShell"

function assembly() {
	return createTaskExecutorAssembly({
		taskId: "task-1",
		initialState: createInitialTaskState("task-1"),
		persistence: {
			vault: new InMemoryStateVault(),
			taskView: new InMemoryTaskViewPort(),
			publications: new InMemoryCommandPublicationStore(),
			journal: new InMemoryConversationJournal(),
		},
		execution: {
			provider: {
				execution: {
					async *start(input) {
						yield {
							kind: "final" as const,
							turnId: input.turnId ?? "turn-1",
							payloadRef: "answer:1",
							turnPlan: { mode: "serial" as const, blocks: [] },
						}
					},
				},
			},
			compose: { compose: async () => ({ draftRef: "draft:1" }) },
			compaction: { run: async () => ({ resultRef: "compacted:1" }) },
			dialog: {
				execution: {
					prepare: async () => ({
						journalRef: "journal:dialog",
						journalWatermark: { seq: 1 },
						receiverGeneration: 1,
						disposition: "created",
					}),
					reveal: async () => ({ disposition: "revealed" }),
				},
			},
			policy: { evaluate: async () => ({ approved: true }) },
			tool: {
				runner: { runBlock: async () => undefined, release: async () => undefined },
				surface: createDeniedSurface("detached_domain"),
				scheduler: new TurnToolScheduler({ readConfiguredLimit: () => undefined }),
			},
		},
	})
}

describe("TaskExecutorAssembly", () => {
	it("assembles each command domain once and every halt participant", () => {
		const assembled = assembly()
		expect(assembled.executors.map((executor) => executor.domain).sort()).toEqual([
			"compaction",
			"compose",
			"dialog",
			"halt",
			"policy",
			"provider",
			"tool",
		])
		expect(assembled.participants.map((participant) => participant.id).sort()).toEqual([...ALL_HALT_PARTICIPANTS].sort())
	})

	it("rearms real participants only after cancel reaches quiescence", async () => {
		const assembled = assembly()
		const shell = new TaskShell(assembled.runtime, assembled.halt)
		const result = await shell.cancel("halt-1")
		expect(result.kind).toBe("accepted")
		expect(assembled.runtime.getState()).toMatchObject({ flow: { phase: "paused" }, halt: { status: "idle" } })
		await expect(assembled.background.publish({ entryId: "background-1", payloadRef: "result:1" })).resolves.toMatchObject({
			kind: "accepted",
		})
	})
})
