import { describe, expect, it, vi } from "vitest"
import { createDeniedSurface } from "../executors/tool/ToolDomainSurface"
import { TurnToolScheduler } from "../executors/tool/TurnToolScheduler"
import { type Command, createInitialTaskState, type TaskState } from "../kernel"
import {
	InMemoryCommandPublicationStore,
	InMemoryConversationJournal,
	InMemoryStateVault,
	InMemoryTaskViewPort,
	type TaskPayloadStore,
} from "../stores"
import { openTaskShell } from "./TaskShellFactory"

const payloads: TaskPayloadStore = {
	put: async () => "payload:1",
	read: async () => new Uint8Array(),
}

function execution(reveal: () => void) {
	return {
		provider: { execution: { async *start() {} } },
		compose: { compose: async () => ({ draftRef: "draft:1" }) },
		compaction: { run: async () => ({ resultRef: "result:1" }) },
		dialog: {
			execution: {
				prepare: async () => ({
					journalRef: "journal:1",
					journalWatermark: { epoch: 0, seq: 0 },
					receiverGeneration: 0,
					disposition: "existing" as const,
				}),
				reveal: async () => {
					reveal()
					return { disposition: "revealed" as const }
				},
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

describe("openTaskShell", () => {
	it("merges hydrate reveal and restored outbox into one replay owner", async () => {
		const interaction = {
			interactionId: "interaction-1",
			turnId: "turn-1",
			kind: "question",
			status: "prepared" as const,
			createdRevision: 7,
			presentationRef: "question:1",
			actionRules: [],
			journalRef: "journal:1",
			journalWatermark: { epoch: 0, seq: 1 },
			receiverGeneration: 0,
			prepareKey: "dialog.prepare:interaction-1",
			revealKey: "dialog.reveal:interaction-1:0",
		}
		const state: TaskState = {
			...createInitialTaskState("task-1"),
			revision: 8,
			journalWatermark: { epoch: 0, seq: 1 },
			dialog: { primary: interaction, approvalsByBlock: {} },
		}
		const reveal: Command = {
			type: "dialog.reveal",
			commandId: "legacy-reveal",
			originRevision: 8,
			generation: 0,
			...interaction,
			revealKey: interaction.revealKey,
		}
		const vault = new InMemoryStateVault()
		await vault.save({ state, outbox: [reveal] })
		const journal = new InMemoryConversationJournal()
		await journal.append({ operationId: "dialog.prepare:interaction-1", payloadRef: "journal:1", source: "dialog" })
		const revealed = vi.fn()
		const opened = await openTaskShell({
			taskId: "task-1",
			openReason: "crash_recovery",
			execution: execution(revealed),
			taskView: new InMemoryTaskViewPort(),
			persistence: {
				ports: {
					vault,
					journal,
					publications: new InMemoryCommandPublicationStore(),
				},
				payloads,
			},
		})
		expect(opened.kind).toBe("ready")
		if (opened.kind !== "ready") return
		await opened.runtime.waitForQuiescence()
		expect(revealed).toHaveBeenCalledTimes(1)
	})
})
