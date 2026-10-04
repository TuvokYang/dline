import { describe, expect, it, vi } from "vitest"
import { createDeniedSurface } from "../executors/tool/ToolDomainSurface"
import { TurnToolScheduler } from "../executors/tool/TurnToolScheduler"
import type { TaskPersistenceAssembly } from "../shell/TaskPersistenceAssembly"
import {
	InMemoryCommandPublicationStore,
	InMemoryConversationJournal,
	InMemoryStateVault,
	InMemoryTaskPayloadStore,
	InMemoryTaskViewPort,
} from "../stores"
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
	} as unknown as TaskCompositionServices
}

describe("TaskCompositionRoot", () => {
	it("exposes the six-use-case facade and keeps compose inside the composition root", async () => {
		const payloads = new InMemoryTaskPayloadStore()
		const journal = new InMemoryConversationJournal()
		const persistence: TaskPersistenceAssembly = {
			ports: { vault: new InMemoryStateVault(), publications: new InMemoryCommandPublicationStore(), journal },
			payloads,
		}
		const provider = vi.fn(({ turnId }: { turnId?: string }) => ({
			async *[Symbol.asyncIterator]() {
				if (!turnId) throw new Error("expected provider turn identity")
				yield { kind: "final" as const, turnId, text: "answer", mode: "serial" as const, blocks: [] }
			},
		}))
		const result = await composeTask({
			taskId: "task-1",
			openReason: "new",
			services: services(provider),
			taskView: new InMemoryTaskViewPort(),
			persistence,
		})
		const payloadRef = await payloads.put(encodeTaskPayload({ kind: "user_input", text: "hello" }))
		await result.task.start({ entryId: "entry-1", payloadRef })
		// This provider answers every round in prose without calling a tool. The
		// kernel continues through such answers until the third, which opens the
		// mistake-limit dialog instead of another round, as dev's default of three
		// consecutive mistakes did. A single call would be the old defect: the task
		// stopped after one unanswered answer.
		await vi.waitFor(() => expect(provider.mock.calls.length).toBeGreaterThan(1))
		await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(3))
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
