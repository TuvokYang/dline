import { strict as assert } from "node:assert"
import { MAX_SUBAGENTS_PER_BATCH } from "@shared/concurrency-limits"
import type { TaskActivityRecord } from "@shared/task-activity"
import { describe, it } from "vitest"
import { TaskActivityStore } from "../TaskActivityStore"

/**
 * One use_subagents call may fan out to 32 items, and every item owns its own
 * activity record carrying a prompt, a result and possibly an error. Those
 * fields are written to the task's activity file, so an unbounded field is
 * multiplied by the batch width on every persist.
 *
 * These tests pin the ceiling that keeps a wide batch from growing task
 * storage without limit.
 */
describe("TaskActivityStore bounded payload", () => {
	const HUGE = "x".repeat(200_000)

	function createSubagentActivity(store: TaskActivityStore, activityId: string, detail: string): void {
		store.create({
			activityId,
			kind: "subagent",
			executionMode: "foreground",
			title: `subagent ${activityId}`,
			detail,
		})
	}

	it("bounds the prompt detail captured at creation", () => {
		const store = new TaskActivityStore("task-bounded")
		createSubagentActivity(store, "item-1", HUGE)

		const detail = store.get("item-1")?.detail ?? ""
		assert.ok(detail.length < HUGE.length, "an oversized prompt must be truncated")
		assert.ok(detail.endsWith("… [truncated]"), "truncation must be visible to the reader")
	})

	it("keeps a normal prompt intact", () => {
		const store = new TaskActivityStore("task-bounded")
		const prompt = "<task>\nreview the parser\n</task>\n<context>\nsee SubagentRequestParser\n</context>"
		createSubagentActivity(store, "item-1", prompt)

		assert.equal(store.get("item-1")?.detail, prompt)
	})

	it("bounds the task and prompt copied into a retry recipe", () => {
		const store = new TaskActivityStore("task-bounded")
		store.create({
			activityId: "item-1",
			kind: "subagent",
			executionMode: "foreground",
			title: "subagent item-1",
			detail: "prompt",
			retryRecipe: {
				kind: "subagent",
				schemaVersion: 1,
				subagentName: "default",
				task: HUGE,
				prompt: HUGE,
				timeoutSeconds: 60,
				retryable: true,
			},
		})

		const recipe = store.get("item-1")?.retryRecipe
		assert.ok((recipe?.task.length ?? 0) < HUGE.length, "an oversized recipe task must be truncated")
		assert.ok((recipe?.prompt.length ?? 0) < HUGE.length, "an oversized recipe prompt must be truncated")
		assert.ok(recipe?.prompt.endsWith("… [truncated]"), "truncation must be visible in the recipe too")
	})

	it("redacts secrets carried by a retry recipe", () => {
		const store = new TaskActivityStore("task-bounded")
		store.create({
			activityId: "item-1",
			kind: "subagent",
			executionMode: "foreground",
			title: "subagent item-1",
			detail: "prompt",
			retryRecipe: {
				kind: "subagent",
				schemaVersion: 1,
				subagentName: "default",
				task: "call the API with Authorization: Bearer abcdef0123456789",
				prompt: 'use api_key="abcdef0123456789" for the request',
				timeoutSeconds: 60,
				retryable: true,
			},
		})

		const recipe = store.get("item-1")?.retryRecipe
		assert.ok(!recipe?.task.includes("abcdef0123456789"), "a recipe must not persist a bearer token verbatim")
		assert.ok(!recipe?.prompt.includes("abcdef0123456789"), "a recipe must not persist an API key verbatim")
	})

	it("bounds a retry recipe supplied through update rather than creation", () => {
		// Creation is not the only way a recipe enters the store: a later update
		// carries one too, and an unbounded one there would be persisted as-is.
		const store = new TaskActivityStore("task-bounded")
		createSubagentActivity(store, "item-1", "prompt")

		store.update("item-1", {
			retryRecipe: {
				kind: "subagent",
				schemaVersion: 1,
				subagentName: "default",
				task: HUGE,
				prompt: 'use api_key="abcdef0123456789" for the request',
				timeoutSeconds: 60,
				retryable: true,
			},
		})

		const recipe = store.get("item-1")?.retryRecipe
		assert.ok((recipe?.task.length ?? 0) < HUGE.length, "an updated recipe task must be truncated")
		assert.ok(recipe?.task.endsWith("… [truncated]"), "truncation must be visible on the update path too")
		assert.ok(!recipe?.prompt.includes("abcdef0123456789"), "an updated recipe must not persist an API key verbatim")
	})

	it("bounds a raw recipe rehydrated from a persisted activity", async () => {
		// Activities written before the bound existed are replayed on load. The
		// store must re-apply the bound instead of trusting the stored document.
		const persisted: TaskActivityRecord = {
			schemaVersion: 2,
			activityId: "item-1",
			taskId: "task-bounded",
			kind: "subagent",
			executionMode: "foreground",
			cancellationOwner: "task",
			status: "failed",
			currentAttempt: 1,
			createdAt: 1,
			updatedAt: 2,
			title: "subagent item-1",
			events: [],
			retryRecipe: {
				kind: "subagent",
				schemaVersion: 1,
				subagentName: "default",
				task: HUGE,
				prompt: 'use api_key="abcdef0123456789" for the request',
				timeoutSeconds: 60,
				retryable: true,
			},
		}
		const store = new TaskActivityStore("task-bounded", {
			load: async () => [persisted],
			save: async () => {},
		})

		await store.hydrate()

		const recipe = store.get("item-1")?.retryRecipe
		assert.ok((recipe?.task.length ?? 0) < HUGE.length, "a rehydrated recipe task must be truncated")
		assert.ok(!recipe?.prompt.includes("abcdef0123456789"), "a rehydrated recipe must not keep an API key verbatim")
	})

	it("bounds the result and error written at completion", () => {
		const store = new TaskActivityStore("task-bounded")
		createSubagentActivity(store, "item-1", "prompt")
		store.update("item-1", { status: "failed", result: HUGE, error: HUGE })

		const activity = store.get("item-1")
		assert.ok((activity?.result?.length ?? 0) < HUGE.length, "an oversized result must be truncated")
		assert.ok((activity?.error?.length ?? 0) < HUGE.length, "an oversized error must be truncated")
	})

	it("keeps a full-width batch within a predictable payload size", () => {
		const store = new TaskActivityStore("task-bounded")
		for (let index = 1; index <= MAX_SUBAGENTS_PER_BATCH; index++) {
			createSubagentActivity(store, `item-${index}`, HUGE)
			store.update(`item-${index}`, { status: "completed", result: HUGE })
		}

		assert.equal(store.list().length, MAX_SUBAGENTS_PER_BATCH)
		const serialized = JSON.stringify(store.list())
		// Without the field ceiling this batch alone would serialize well past
		// 12 MB; the bound keeps it proportional to the declared limits.
		const unboundedSize = MAX_SUBAGENTS_PER_BATCH * HUGE.length * 2
		assert.ok(
			serialized.length < unboundedSize / 4,
			`a full batch must stay well under the unbounded size, got ${serialized.length}`,
		)
	})
})
