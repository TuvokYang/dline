import { describe, expect, it } from "vitest"
import { createDeniedSurface } from "../../executors/tool/ToolDomainSurface"
import { TurnToolScheduler } from "../../executors/tool/TurnToolScheduler"
import type { TaskState } from "../../kernel"
import {
	InMemoryCommandPublicationStore,
	InMemoryConversationJournal,
	InMemoryStateVault,
	InMemoryTaskViewPort,
	type TaskPayloadStore,
} from "../../stores"
import { openTaskShell } from "../TaskShellFactory"

const payloads: TaskPayloadStore = {
	put: async () => "sha256:0000000000000000000000000000000000000000000000000000000000000000",
	read: async () => new Uint8Array(),
}

/**
 * The runtime snapshot a turn-ending tool leaves behind.
 *
 * Copied from a recorded E2E artifact: the flow is terminated, the only block
 * was cancelled, and no dialog survived. Reopening it from history is the one
 * way back into the task, so the recovery dialog has to become answerable
 * without any further user action.
 */
function terminatedHistorySnapshot(): TaskState {
	return {
		taskId: "task-1",
		revision: 58,
		generation: 3,
		flow: { phase: "terminated" },
		turn: {
			turnId: "turn-1",
			mode: "serial",
			blocks: [
				{
					blockId: "block-1",
					index: 0,
					phase: "cancelled",
					attempt: "attempt-1",
					lanes: ["user-interaction"],
					turnEnding: true,
					invocationRef: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
				},
			],
			manualApprovalBlockIds: [],
			automaticApprovalBlockIds: [],
			executingBlockIds: [],
		},
		dialog: { approvalsByBlock: {} },
		intake: {
			queued: [
				{
					entryId: "task-1:input:1",
					payloadRef: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
					source: "user",
					mode: "queued",
					sequence: 0,
					state: "consumed",
					journalWatermark: { seq: 3 },
				},
			],
			background: [],
			coTask: [],
		},
		halt: { status: "idle", generation: 3 },
		journalWatermark: { seq: 1 },
	}
}

function execution() {
	return {
		provider: { execution: { async *start() {} } },
		compose: { compose: async () => ({ draftRef: "draft:1" }) },
		compaction: { run: async () => ({ resultRef: "result:1" }) },
		dialog: {
			execution: {
				prepare: async (input: { readonly interactionId: string }) => ({
					journalRef: `journal:2`,
					journalWatermark: { seq: 2 },
					receiverGeneration: 4,
					disposition: "created" as const,
					interactionId: input.interactionId,
				}),
				reveal: async () => ({ disposition: "revealed" as const }),
			},
		},
		policy: { evaluate: async () => ({ approved: true }) },
		tool: {
			runner: { runBlock: async () => undefined, release: async () => undefined },
			surface: createDeniedSurface("detached_domain"),
			scheduler: new TurnToolScheduler({ readConfiguredLimit: () => undefined }),
		},
		spawn: {
			prepare: async () => ({ admit: async () => ({ childTaskId: "child-1" }), dispose: async () => undefined }),
		},
	}
}

describe("promoting a terminated task from history", () => {
	it("drives the recovery dialog all the way to awaiting a response", async () => {
		const vault = new InMemoryStateVault()
		await vault.save({ state: terminatedHistorySnapshot(), outbox: [] })
		const journal = new InMemoryConversationJournal()
		await journal.append({ operationId: "seed:1", payloadRef: "payload:1", source: "system" })

		const opened = await openTaskShell({
			taskId: "task-1",
			openReason: "resume",
			execution: execution(),
			taskView: new InMemoryTaskViewPort(),
			persistence: {
				ports: { vault, journal, publications: new InMemoryCommandPublicationStore() },
				payloads,
			},
		})

		expect(opened.kind).toBe("ready")
		if (opened.kind !== "ready") return
		expect(opened.form).toBe("interrupted")
		await opened.runtime.waitForQuiescence()

		const dialog = opened.runtime.getState().dialog.primary
		expect(dialog).toMatchObject({ kind: "resume", status: "awaiting" })
		expect(dialog?.receiverGeneration).toBeDefined()
	})
})
