import { afterEach, describe, expect, it, vi } from "vitest"
import { TaskActivityStore } from "./TaskActivityStore"

describe("TaskActivityStore", () => {
	afterEach(() => vi.useRealTimers())

	it("sends one initial snapshot and batches output updates", async () => {
		vi.useFakeTimers()
		const store = new TaskActivityStore("task-1")
		const listener = vi.fn()
		store.subscribe(listener)
		store.create({
			activityId: "command-1",
			kind: "command",
			executionMode: "foreground",
			title: "npm test",
		})
		await vi.advanceTimersByTimeAsync(0)
		listener.mockClear()

		store.appendOutput("command-1", "first\n")
		store.appendOutput("command-1", "second\n")
		expect(listener).not.toHaveBeenCalled()

		await vi.advanceTimersByTimeAsync(75)
		expect(listener).toHaveBeenCalledTimes(1)
		expect(listener.mock.calls[0][0]).toMatchObject({
			snapshot: false,
			activities: [{ activityId: "command-1", output: "first\nsecond\n" }],
		})
	})

	it("keeps only the bounded output tail", () => {
		const store = new TaskActivityStore("task-1")
		store.create({
			activityId: "command-1",
			kind: "command",
			executionMode: "background",
			title: "large output",
		})
		store.appendOutput("command-1", `${"a".repeat(70_000)}tail`)

		const output = store.get("command-1")?.output
		expect(output).toHaveLength(64 * 1024)
		expect(output?.endsWith("tail")).toBe(true)
	})

	it("keeps command output raw without synthetic output or metrics events", () => {
		const store = new TaskActivityStore("task-1")
		store.create({
			activityId: "command-1",
			kind: "command",
			executionMode: "foreground",
			title: "npm test",
		})

		store.appendOutput("command-1", "actual stdout\n")
		store.update("command-1", { metrics: { lineCount: 1 } })

		const activity = store.get("command-1")
		expect(activity?.output).toBe("actual stdout\n")
		expect(activity?.metrics).toBeUndefined()
		expect(activity?.events.map((event) => event.kind)).toEqual(["status"])
	})

	it("filters task-owned activities without treating explicit background work as Task lifecycle work", () => {
		const store = new TaskActivityStore("task-1")
		store.create({
			activityId: "foreground-command",
			kind: "command",
			executionMode: "foreground",
			cancellationOwner: "task",
			title: "npm test",
		})
		store.create({
			activityId: "background-command",
			kind: "command",
			executionMode: "background",
			cancellationOwner: "explicit",
			title: "npm run dev",
		})

		expect(store.listRunning("task").map((activity) => activity.activityId)).toEqual(["foreground-command"])
	})

	it("requests soft finish without cancelling or terminating the subagent activity", async () => {
		const finish = vi.fn(async () => true)
		const store = new TaskActivityStore("task-1")
		store.create({
			activityId: "subagent-finish",
			kind: "subagent",
			executionMode: "background",
			title: "research",
			finish,
		})

		expect(store.isFinishable("subagent-finish")).toBe(true)
		expect(await store.finish(["subagent-finish"])).toEqual(["subagent-finish"])
		expect(finish).toHaveBeenCalledTimes(1)
		expect(store.get("subagent-finish")).toMatchObject({
			status: "running",
			latestEvent: "Finish requested",
		})
		expect(store.isFinishable("subagent-finish")).toBe(false)
		expect(await store.finish(["subagent-finish"])).toEqual([])
	})

	it("publishes capability-only changes to activity subscribers", async () => {
		const store = new TaskActivityStore("task-1")
		store.create({
			activityId: "subagent-capabilities",
			kind: "subagent",
			executionMode: "background",
			title: "research",
		})
		store.update("subagent-capabilities", { status: "failed" })
		const listener = vi.fn()
		store.subscribe(listener)
		await vi.waitFor(() => expect(listener).toHaveBeenCalled())
		listener.mockClear()

		store.setRetry("subagent-capabilities", async () => true)

		await vi.waitFor(() => expect(listener).toHaveBeenCalled())
		expect(store.isRetryable("subagent-capabilities")).toBe(true)
		expect(listener.mock.calls.at(-1)?.[0]).toMatchObject({
			snapshot: false,
			activities: [{ activityId: "subagent-capabilities", status: "failed" }],
		})
	})

	it("rejects duplicate activity identities instead of rebinding a historical record", () => {
		const store = new TaskActivityStore("task-1")
		store.create({
			activityId: "subagent-collision",
			kind: "subagent",
			executionMode: "background",
			title: "first task",
		})

		expect(() =>
			store.create({
				activityId: "subagent-collision",
				kind: "subagent",
				executionMode: "background",
				title: "second task",
			}),
		).toThrow("Task activity already exists: subagent-collision")
		expect(store.get("subagent-collision")?.title).toBe("first task")
	})

	it("retries a retained failed subagent with the same activity identity", async () => {
		const retry = vi.fn(async () => true)
		const store = new TaskActivityStore("task-1")
		store.create({
			activityId: "subagent-retry",
			kind: "subagent",
			executionMode: "background",
			title: "research",
			retry,
		})
		store.update("subagent-retry", { status: "failed", error: "temporary provider failure" })

		expect(store.isRetryable("subagent-retry")).toBe(true)
		expect(await store.retry(["subagent-retry"])).toEqual(["subagent-retry"])
		expect(retry).toHaveBeenCalledTimes(1)
		expect(store.get("subagent-retry")).toMatchObject({
			activityId: "subagent-retry",
			status: "running",
			latestEvent: "Retry requested",
		})
		expect(store.get("subagent-retry")?.error).toBeUndefined()
		expect(store.get("subagent-retry")?.finishedAt).toBeUndefined()
		expect(store.isRetryable("subagent-retry")).toBe(false)
	})

	// BUGFIX-022: a user cancellation stops the run without producing a result,
	// so it must offer the same recovery path as a provider failure.
	it("retries a cancelled subagent with the same activity identity", async () => {
		const retry = vi.fn(async () => true)
		const store = new TaskActivityStore("task-1")
		store.create({
			activityId: "subagent-cancelled",
			kind: "subagent",
			executionMode: "background",
			title: "research",
			retry,
		})
		store.update("subagent-cancelled", { status: "cancelled", error: "Subagent run cancelled." })

		expect(store.isRetryable("subagent-cancelled")).toBe(true)
		expect(await store.retry(["subagent-cancelled"])).toEqual(["subagent-cancelled"])
		expect(retry).toHaveBeenCalledTimes(1)
		expect(store.get("subagent-cancelled")).toMatchObject({
			activityId: "subagent-cancelled",
			status: "running",
			latestEvent: "Retry requested",
		})
	})

	// A refused retry must restore the original terminal state, not rewrite history.
	it("restores the cancelled state when a retry is refused", async () => {
		const retry = vi.fn(async () => false)
		const store = new TaskActivityStore("task-1")
		store.create({
			activityId: "subagent-refused",
			kind: "subagent",
			executionMode: "background",
			title: "research",
			retry,
		})
		store.update("subagent-refused", { status: "cancelled", error: "Subagent run cancelled." })

		expect(await store.retry(["subagent-refused"])).toEqual([])
		expect(store.get("subagent-refused")).toMatchObject({
			status: "cancelled",
			error: "Subagent run cancelled.",
			latestEvent: "Retry unavailable",
		})
	})

	it("keeps events separated by execution attempt across retry", async () => {
		const store = new TaskActivityStore("task-1")
		store.create({
			activityId: "subagent-attempts",
			kind: "subagent",
			executionMode: "background",
			title: "research",
			retry: async () => true,
		})
		store.appendEvent("subagent-attempts", { kind: "assistant_message", phase: "final", text: "first attempt" })
		store.update("subagent-attempts", { status: "failed", error: "temporary failure" })

		expect(await store.retry(["subagent-attempts"])).toEqual(["subagent-attempts"])
		store.appendEvent("subagent-attempts", { kind: "assistant_message", phase: "final", text: "second attempt" })

		const activity = store.get("subagent-attempts")
		expect(activity?.currentAttempt).toBe(2)
		expect(
			activity?.events.find((event) => event.kind === "assistant_message" && event.text === "first attempt")?.attempt,
		).toBe(1)
		expect(
			activity?.events.find((event) => event.kind === "assistant_message" && event.text === "second attempt")?.attempt,
		).toBe(2)
	})

	it("persists retry recipes without treating them as live retry controls after reopen", async () => {
		const persisted: Array<ReturnType<TaskActivityStore["list"]>> = []
		const persistence = {
			load: vi.fn(async () => persisted.at(-1) ?? []),
			save: vi.fn(async (activities: ReturnType<TaskActivityStore["list"]>) => {
				persisted.push(activities)
			}),
		}
		const store = new TaskActivityStore("task-1", persistence)
		store.create({
			activityId: "subagent-recipe",
			kind: "subagent",
			executionMode: "background",
			title: "research",
			retryRecipe: {
				kind: "subagent",
				schemaVersion: 1,
				subagentName: "default",
				task: "inspect retry",
				prompt: "<task>inspect retry</task><context>ctx</context>",
				timeoutSeconds: 30,
				retryable: true,
			},
		})
		store.update("subagent-recipe", { status: "failed", error: "temporary failure" })
		await store.waitForPersistence()

		const reopened = new TaskActivityStore("task-1", persistence)
		await reopened.hydrate()

		expect(reopened.get("subagent-recipe")).toMatchObject({
			schemaVersion: 2,
			currentAttempt: 1,
			retryRecipe: {
				kind: "subagent",
				schemaVersion: 1,
				subagentName: "default",
				task: "inspect retry",
				timeoutSeconds: 30,
				retryable: true,
			},
		})
		expect(reopened.isRetryable("subagent-recipe")).toBe(true)
		expect(reopened.hasLiveRetryControl("subagent-recipe")).toBe(false)
		reopened.setRetry("subagent-recipe", async () => true)
		expect(reopened.isRetryable("subagent-recipe")).toBe(true)
		expect(reopened.hasLiveRetryControl("subagent-recipe")).toBe(true)
	})

	it("does not expose subagent finish or retry controls for command activities", async () => {
		const store = new TaskActivityStore("task-1")
		store.create({
			activityId: "command-controls",
			kind: "command",
			executionMode: "background",
			title: "npm test",
			finish: async () => true,
			retry: async () => true,
		})
		store.update("command-controls", { status: "failed" })

		expect(store.isFinishable("command-controls")).toBe(false)
		expect(store.isRetryable("command-controls")).toBe(false)
		expect(await store.finish(["command-controls"])).toEqual([])
		expect(await store.retry(["command-controls"])).toEqual([])
	})

	it("exposes cancellation only while a live canceller is bound", () => {
		const store = new TaskActivityStore("task-1")
		store.create({
			activityId: "subagent-1",
			kind: "subagent",
			executionMode: "background",
			title: "research",
		})

		expect(store.isCancellable("subagent-1")).toBe(false)
		store.setCancel("subagent-1", async () => undefined)
		expect(store.isCancellable("subagent-1")).toBe(true)
		store.update("subagent-1", { status: "completed" })
		expect(store.isCancellable("subagent-1")).toBe(false)
	})

	// Cancelling a batch must not serialize on the slowest canceller. A single
	// unresponsive activity would otherwise consume the caller's whole timeout
	// budget and leave the remaining activities untouched.
	it("cancels a batch concurrently instead of waiting for each canceller in turn", async () => {
		const store = new TaskActivityStore("task-1")
		let releaseSlow!: () => void
		const slowCancelled = new Promise<void>((resolve) => {
			releaseSlow = resolve
		})
		const started: string[] = []
		for (const activityId of ["slow-1", "fast-2", "fast-3"]) {
			store.create({
				activityId,
				kind: "command",
				executionMode: "foreground",
				title: activityId,
				cancel: async () => {
					started.push(activityId)
					if (activityId === "slow-1") await slowCancelled
				},
			})
		}

		const cancelling = store.cancel(["slow-1", "fast-2", "fast-3"])
		await vi.waitFor(() => expect(started).toEqual(["slow-1", "fast-2", "fast-3"]))
		// The fast activities reach their terminal state while the slow one is
		// still pending, proving they were not queued behind it.
		await vi.waitFor(() => {
			expect(store.get("fast-2")?.status).toBe("cancelled")
			expect(store.get("fast-3")?.status).toBe("cancelled")
		})
		expect(store.get("slow-1")?.status).toBe("cancelling")

		releaseSlow()
		expect((await cancelling).sort()).toEqual(["fast-2", "fast-3", "slow-1"])
	})

	// One failing canceller must not abort the rest of the batch.
	it("keeps cancelling the remaining activities when one canceller rejects", async () => {
		const store = new TaskActivityStore("task-1")
		store.create({
			activityId: "failing-1",
			kind: "command",
			executionMode: "foreground",
			title: "failing",
			cancel: async () => {
				throw new Error("terminate refused")
			},
		})
		store.create({
			activityId: "healthy-2",
			kind: "command",
			executionMode: "foreground",
			title: "healthy",
			cancel: async () => undefined,
		})

		expect(await store.cancel(["failing-1", "healthy-2"])).toEqual(["healthy-2"])
		expect(store.get("failing-1")?.status).toBe("failed")
		expect(store.get("failing-1")?.error).toBe("terminate refused")
		expect(store.get("healthy-2")?.status).toBe("cancelled")
	})

	it("keeps ordered typed events and persists history for reopen", async () => {
		const persisted: Array<ReturnType<TaskActivityStore["list"]>> = []
		const persistence = {
			load: vi.fn(async () => persisted.at(-1) ?? []),
			save: vi.fn(async (activities: ReturnType<TaskActivityStore["list"]>) => {
				persisted.push(activities)
			}),
		}
		const store = new TaskActivityStore("task-1", persistence)
		store.create({
			activityId: "subagent-1",
			kind: "subagent",
			executionMode: "background",
			title: "research",
		})
		store.appendEvent("subagent-1", { kind: "thinking", phase: "delta", text: "considering" })
		store.appendEvent("subagent-1", {
			kind: "assistant_message",
			phase: "final",
			text: "I will inspect it. api_key=private-value",
		})
		store.appendEvent("subagent-1", {
			kind: "tool_call",
			toolCallId: "tid-1",
			toolName: "read_file",
			toolStatus: "started",
			summary: "read target",
		})
		store.appendEvent("subagent-1", {
			kind: "tool_result",
			toolCallId: "tid-1",
			toolName: "read_file",
			text: "file content",
		})
		store.update("subagent-1", { metrics: { toolCalls: 1, inputTokens: 10 } })
		await store.waitForPersistence()

		const events = store.get("subagent-1")?.events ?? []
		expect(events.map((event) => event.kind)).toEqual([
			"status",
			"thinking",
			"assistant_message",
			"tool_call",
			"tool_result",
			"metrics",
		])
		expect(events.map((event) => event.sequence)).toEqual([...events.map((event) => event.sequence)].sort((a, b) => a - b))
		expect(events.find((event) => event.kind === "assistant_message")).toMatchObject({
			text: "I will inspect it. api_key=[REDACTED]",
		})

		const reopened = new TaskActivityStore("task-1", persistence)
		await reopened.hydrate()
		expect(reopened.get("subagent-1")?.events).toEqual(events)
		expect(reopened.isCancellable("subagent-1")).toBe(false)
	})

	it("preserves complete tool history when verbose streaming exceeds the activity event cap", async () => {
		const persisted: Array<ReturnType<TaskActivityStore["list"]>> = []
		const persistence = {
			load: vi.fn(async () => persisted.at(-1) ?? []),
			save: vi.fn(async (activities: ReturnType<TaskActivityStore["list"]>) => {
				persisted.push(activities)
			}),
		}
		const store = new TaskActivityStore("task-1", persistence)
		store.create({
			activityId: "subagent-verbose",
			kind: "subagent",
			executionMode: "background",
			title: "verbose research",
		})
		store.appendEvent("subagent-verbose", {
			kind: "tool_call",
			toolCallId: "early-tool",
			toolName: "read_file",
			toolStatus: "completed",
			summary: "read_file(path=README.md)",
		})
		store.appendEvent("subagent-verbose", {
			kind: "tool_result",
			toolCallId: "early-tool",
			toolName: "read_file",
			text: "early result",
		})

		for (let index = 0; index < 600; index += 1) {
			store.appendEvent("subagent-verbose", {
				kind: index % 2 === 0 ? "thinking" : "assistant_message",
				phase: "delta",
				text: `stream-${index}`,
			})
		}

		store.appendEvent("subagent-verbose", {
			kind: "tool_call",
			toolCallId: "late-tool",
			toolName: "list_files",
			toolStatus: "completed",
			summary: "list_files(path=src)",
		})
		store.appendEvent("subagent-verbose", {
			kind: "tool_result",
			toolCallId: "late-tool",
			toolName: "list_files",
			text: "late result",
		})
		await store.waitForPersistence()

		const events = store.get("subagent-verbose")?.events ?? []
		expect(events.length).toBeLessThanOrEqual(500)
		expect(events.filter((event) => event.kind === "tool_call").map((event) => event.toolCallId)).toEqual([
			"early-tool",
			"late-tool",
		])
		expect(events.filter((event) => event.kind === "tool_result").map((event) => event.toolCallId)).toEqual([
			"early-tool",
			"late-tool",
		])

		const reopened = new TaskActivityStore("task-1", persistence)
		await reopened.hydrate()
		expect(
			reopened
				.get("subagent-verbose")
				?.events.filter((event) => event.kind === "tool_call")
				.map((event) => event.toolCallId),
		).toEqual(["early-tool", "late-tool"])
	})

	it("retains one ordered tool row per call when tool lifecycle events alone exceed the cap", () => {
		const store = new TaskActivityStore("task-1")
		store.create({
			activityId: "subagent-many-tools",
			kind: "subagent",
			executionMode: "background",
			title: "many tools",
		})
		for (let index = 0; index < 260; index += 1) {
			const toolCallId = `tool-${index}`
			store.appendEvent("subagent-many-tools", {
				kind: "tool_call",
				toolCallId,
				toolName: "read_file",
				toolStatus: "started",
			})
			store.appendEvent("subagent-many-tools", {
				kind: "tool_call",
				toolCallId,
				toolName: "read_file",
				toolStatus: "completed",
				summary: `read_file(path=file-${index}.ts)`,
			})
			store.appendEvent("subagent-many-tools", {
				kind: "tool_result",
				toolCallId,
				toolName: "read_file",
				text: `result-${index}`,
			})
		}

		const toolCalls =
			store
				.get("subagent-many-tools")
				?.events.filter((event) => event.kind === "tool_call")
				.filter((event) => event.toolStatus === "completed") ?? []
		expect(toolCalls).toHaveLength(260)
		expect(toolCalls.map((event) => event.toolCallId)).toEqual(Array.from({ length: 260 }, (_, index) => `tool-${index}`))
	})

	it("merges hydrated history before persisting an opening live activity", async () => {
		let resolveLoad!: (activities: ReturnType<TaskActivityStore["list"]>) => void
		const load = vi.fn(
			async () =>
				new Promise<ReturnType<TaskActivityStore["list"]>>((resolve) => {
					resolveLoad = resolve
				}),
		)
		const save = vi.fn(async (_activities: ReturnType<TaskActivityStore["list"]>) => undefined)
		const historicalStore = new TaskActivityStore("task-1")
		historicalStore.create({
			activityId: "historical-command",
			kind: "command",
			executionMode: "background",
			title: "historical",
		})
		const store = new TaskActivityStore("task-1", { load, save })
		const unsubscribe = store.subscribe(vi.fn())
		store.create({
			activityId: "live-command",
			kind: "command",
			executionMode: "foreground",
			title: "live",
		})
		resolveLoad(historicalStore.list())
		await store.waitForPersistence()
		unsubscribe()

		expect(
			save.mock.calls
				.at(-1)?.[0]
				.map((activity) => activity.activityId)
				.sort(),
		).toEqual(["historical-command", "live-command"])
	})

	it("does not interrupt live activities created after persisted history hydration", async () => {
		const historicalStore = new TaskActivityStore("task-1")
		historicalStore.create({
			activityId: "historical-command",
			kind: "command",
			executionMode: "background",
			title: "historical",
		})
		const reopened = new TaskActivityStore("task-1", {
			load: vi.fn(async () => historicalStore.list()),
			save: vi.fn(async () => undefined),
		})

		await reopened.hydrate()
		reopened.create({
			activityId: "live-command",
			kind: "command",
			executionMode: "foreground",
			title: "live",
		})

		expect(await reopened.recoverInterruptedActivities()).toEqual(["historical-command"])
		expect(reopened.get("historical-command")?.status).toBe("interrupted")
		expect(reopened.get("live-command")?.status).toBe("running")
	})

	it("recovers persisted transient activities as interrupted only when explicitly requested", async () => {
		const historicalStore = new TaskActivityStore("task-1")
		historicalStore.create({
			activityId: "running-zero-timeout",
			kind: "command",
			executionMode: "background",
			title: "serve forever",
			timeoutSeconds: 0,
		})
		historicalStore.create({
			activityId: "cancelling-negative-timeout",
			kind: "command",
			executionMode: "foreground",
			title: "legacy command",
			timeoutSeconds: -1,
		})
		historicalStore.update("cancelling-negative-timeout", {
			status: "cancelling",
			latestEvent: "Cancellation requested",
		})
		historicalStore.create({
			activityId: "awaiting-agent",
			kind: "subagent",
			executionMode: "background",
			status: "awaiting_approval",
			title: "waiting for approval",
		})
		historicalStore.create({
			activityId: "completed-command",
			kind: "command",
			executionMode: "foreground",
			title: "already complete",
		})
		historicalStore.update("completed-command", { status: "completed", latestEvent: "Command completed" })

		const save = vi.fn(async (_activities: ReturnType<TaskActivityStore["list"]>) => undefined)
		const reopened = new TaskActivityStore("task-1", {
			load: vi.fn(async () => historicalStore.list()),
			save,
		})

		await reopened.hydrate()
		expect(reopened.get("running-zero-timeout")?.status).toBe("running")
		expect(save).not.toHaveBeenCalled()

		expect((await reopened.recoverInterruptedActivities()).sort()).toEqual([
			"awaiting-agent",
			"cancelling-negative-timeout",
			"running-zero-timeout",
		])
		for (const activityId of ["running-zero-timeout", "cancelling-negative-timeout", "awaiting-agent"]) {
			const activity = reopened.get(activityId)
			expect(activity).toMatchObject({
				status: "interrupted",
				latestEvent: "Interrupted before completion",
			})
			expect(activity?.finishedAt).toEqual(expect.any(Number))
			expect(
				activity?.events.filter(
					(event) =>
						event.kind === "status" &&
						event.status === "interrupted" &&
						event.text === "Interrupted before completion",
				),
			).toHaveLength(1)
			expect(reopened.isCancellable(activityId)).toBe(false)
		}
		expect(reopened.get("completed-command")?.status).toBe("completed")
		expect(reopened.listRunning()).toEqual([])
		expect(save).toHaveBeenCalledTimes(1)
		expect(save.mock.calls.at(-1)?.[0].map((activity) => activity.status)).toContain("interrupted")

		const saveCount = save.mock.calls.length
		expect(await reopened.recoverInterruptedActivities()).toEqual([])
		expect(save).toHaveBeenCalledTimes(saveCount)
		reopened.update("running-zero-timeout", { status: "completed", result: "late result" })
		expect(reopened.get("running-zero-timeout")?.status).toBe("interrupted")
		expect(reopened.get("running-zero-timeout")?.result).toBeUndefined()
	})

	it("redacts obvious secrets from every persisted activity text field", async () => {
		const save = vi.fn(async (_activities: ReturnType<TaskActivityStore["list"]>) => undefined)
		const store = new TaskActivityStore("task-1", {
			load: vi.fn(async () => []),
			save,
		})
		store.create({
			activityId: "command-1",
			kind: "command",
			executionMode: "background",
			title: "serve --api_key=title-secret",
			detail: "Authorization: Bearer detail-secret-token",
		})
		store.appendOutput("command-1", "access_token=output-secret\n")
		store.update("command-1", {
			status: "completed",
			latestEvent: "password=event-secret",
			result: "github_pat_1234567890abcdef",
			error: "secret=error-secret",
		})
		await store.waitForPersistence()

		const serialized = JSON.stringify(save.mock.calls.at(-1)?.[0])
		expect(serialized).toContain("[REDACTED]")
		for (const secret of [
			"title-secret",
			"detail-secret-token",
			"output-secret",
			"event-secret",
			"github_pat_1234567890abcdef",
			"error-secret",
		]) {
			expect(serialized).not.toContain(secret)
		}
	})

	it("cancels an exact activity and suppresses late completion", async () => {
		const cancel = vi.fn(async () => undefined)
		const store = new TaskActivityStore("task-1")
		store.create({
			activityId: "subagent-1",
			kind: "subagent",
			executionMode: "background",
			title: "research",
			cancel,
		})

		expect(await store.cancel(["subagent-1"])).toEqual(["subagent-1"])
		store.update("subagent-1", { status: "completed", result: "late result" })

		expect(cancel).toHaveBeenCalledTimes(1)
		expect(store.get("subagent-1")?.status).toBe("cancelled")
		expect(store.get("subagent-1")?.result).toBeUndefined()
	})

	it("exposes only the active foreground subagent that can continue in the background", () => {
		const store = new TaskActivityStore("task-1")
		store.create({
			activityId: "subagent-ready",
			kind: "subagent",
			executionMode: "foreground",
			title: "ready",
			continueInBackground: async () => true,
		})
		store.create({
			activityId: "subagent-no-handoff",
			kind: "subagent",
			executionMode: "foreground",
			title: "no handoff",
		})
		store.create({
			activityId: "subagent-background",
			kind: "subagent",
			executionMode: "background",
			title: "background",
			continueInBackground: async () => true,
		})

		expect(store.getReadyBackgroundHandoffActivityId("subagent")).toBe("subagent-ready")
		expect(store.getReadyBackgroundHandoffActivityId("command")).toBeUndefined()

		store.update("subagent-ready", { status: "completed" })
		expect(store.getReadyBackgroundHandoffActivityId("subagent")).toBeUndefined()
	})

	it("moves an eligible foreground activity to explicit background ownership", async () => {
		const move = vi.fn(async () => true)
		const store = new TaskActivityStore("task-1")
		store.create({
			activityId: "subagent-foreground",
			kind: "subagent",
			executionMode: "foreground",
			title: "research",
			continueInBackground: move,
		})

		expect(await store.moveToBackground(["subagent-foreground"])).toEqual(["subagent-foreground"])
		expect(move).toHaveBeenCalledTimes(1)
		expect(store.get("subagent-foreground")).toMatchObject({
			executionMode: "background",
			cancellationOwner: "explicit",
			latestEvent: "Continuing in background",
		})
		expect(await store.moveToBackground(["subagent-foreground"])).toEqual([])
	})

	it("does not start a grouped handoff when any activity is missing", async () => {
		const move = vi.fn(async () => true)
		const store = new TaskActivityStore("task-1")
		store.create({
			activityId: "batch-1",
			kind: "subagent",
			executionMode: "foreground",
			title: "batch item",
			continueInBackground: move,
			backgroundGroupIds: ["batch-1", "batch-2"],
		})

		expect(await store.moveToBackground(["batch-1"])).toEqual([])
		expect(move).not.toHaveBeenCalled()
		expect(store.get("batch-1")?.executionMode).toBe("foreground")
	})

	it("rolls back every grouped activity when an ownership update fails", async () => {
		const rollback = vi.fn(async () => undefined)
		const move = vi.fn(async () => ({ accepted: true, rollback }))
		const store = new TaskActivityStore("task-1")
		for (const activityId of ["batch-1", "batch-2"]) {
			store.create({
				activityId,
				kind: "subagent",
				executionMode: "foreground",
				title: activityId,
				continueInBackground: move,
				backgroundGroupIds: ["batch-1", "batch-2"],
			})
		}
		const originalUpdate = store.update.bind(store)
		let updateCount = 0
		vi.spyOn(store, "update").mockImplementation((activityId, patch) => {
			updateCount += 1
			if (updateCount === 2) throw new Error("second update failed")
			originalUpdate(activityId, patch)
		})

		expect(await store.moveToBackground(["batch-1"])).toEqual([])
		expect(rollback).toHaveBeenCalledOnce()
		expect(store.list().map((activity) => activity.executionMode)).toEqual(["foreground", "foreground"])
	})

	it("preserves terminal progress when a grouped activity finishes during handoff publication", async () => {
		let releaseMove: (() => void) | undefined
		const moverGate = new Promise<void>((resolve) => {
			releaseMove = resolve
		})
		const rollback = vi.fn(async () => undefined)
		const commit = vi.fn(async () => undefined)
		const move = vi.fn(async () => {
			await moverGate
			return { accepted: true, rollback, commit }
		})
		const store = new TaskActivityStore("task-1")
		for (const activityId of ["batch-1", "batch-2"]) {
			store.create({
				activityId,
				kind: "subagent",
				executionMode: "foreground",
				title: activityId,
				continueInBackground: move,
				backgroundGroupIds: ["batch-1", "batch-2"],
			})
		}

		const handoff = store.moveToBackground(["batch-1"])
		await Promise.resolve()
		store.update("batch-2", { status: "completed", result: "finished during publication" })
		releaseMove?.()

		expect(await handoff).toEqual([])
		expect(rollback).toHaveBeenCalledOnce()
		expect(commit).not.toHaveBeenCalled()
		expect(store.get("batch-2")).toMatchObject({
			status: "completed",
			result: "finished during publication",
			executionMode: "foreground",
		})
	})
})
