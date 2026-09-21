import os from "node:os"
import path from "node:path"
import { describe, expect, it, vi } from "vitest"
import { createDeniedSurface } from "../executors/tool/ToolDomainSurface"
import { TurnToolScheduler } from "../executors/tool/TurnToolScheduler"
import type { TaskPersistenceAssembly } from "../shell/TaskPersistenceAssembly"
import { InMemoryCommandPublicationStore, InMemoryConversationJournal, InMemoryStateVault, InMemoryTaskViewPort } from "../stores"
import { FileTaskPayloadStore } from "../stores/FileTaskPayloadStore"
import { encodeTaskPayload } from "../stores/payload/TaskPayloadCodec"
import { composeTask, type TaskCompositionServices } from "./TaskCompositionRoot"

function services(provider: ReturnType<typeof vi.fn>): TaskCompositionServices {
	return {
		provider: { start: provider },
		compaction: { run: vi.fn(async () => ({ summary: "done" })) },
		readApprovalPolicy: () => ({ settings: { actions: {} } }),
		toolResources: {
			revertDiff: vi.fn(async () => undefined),
			cancelCommand: vi.fn(async () => undefined),
		},
		toolSurface: createDeniedSurface("detached_domain"),
		toolScheduler: new TurnToolScheduler({ readConfiguredLimit: () => undefined }),
		tool: { execute: vi.fn(async () => ({ content: "done" })) },
		spawn: {
			reserve: vi.fn(async () => ({
				childTaskId: "child",
				admit: async () => undefined,
				dispose: async () => undefined,
			})),
		},
	} as unknown as TaskCompositionServices
}

describe("TaskCompositionRoot", () => {
	it("exposes the six-use-case facade and keeps compose inside the composition root", async () => {
		const directory = path.join(os.tmpdir(), `dline-task-composition-${Date.now()}`)
		const payloads = new FileTaskPayloadStore(path.join(directory, "payloads"))
		const journal = new InMemoryConversationJournal()
		const persistence: TaskPersistenceAssembly = {
			ports: { vault: new InMemoryStateVault(), publications: new InMemoryCommandPublicationStore(), journal },
			payloads,
		}
		const provider = vi.fn(() => ({
			async *[Symbol.asyncIterator]() {
				yield { kind: "final" as const, turnId: "turn-1", text: "answer", mode: "serial" as const, blocks: [] }
			},
		}))
		const result = await composeTask({
			taskId: "task-1",
			openReason: "new",
			services: services(provider),
			taskView: new InMemoryTaskViewPort(),
			persistence,
		})
		expect(result.kind).toBe("ready")
		if (result.kind !== "ready") return
		const payloadRef = await payloads.put(encodeTaskPayload({ kind: "user_input", text: "hello" }))
		await result.task.start({ entryId: "entry-1", payloadRef })
		await vi.waitFor(() => expect(provider).toHaveBeenCalledOnce())
		expect(Object.getOwnPropertyNames(Object.getPrototypeOf(result.task)).sort()).toEqual([
			"cancel",
			"constructor",
			"open",
			"respond",
			"start",
			"submitInput",
			"terminate",
		])
	})
})
