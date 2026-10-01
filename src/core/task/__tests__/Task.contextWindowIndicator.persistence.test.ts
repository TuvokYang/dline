import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { ContextWindowIndicatorSnapshot } from "@shared/context-window-indicator"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ensureTaskDirectoryExists, GlobalFileNames } from "@/core/storage/disk"
import { ContextWindowIndicator } from "../ContextWindowIndicator"
import { Task } from "../index"
import { TaskPhase } from "../TaskPhase"
import { createSnapshot, hydrateSnapshot, type TaskSnapshot } from "../TaskSnapshot"

const taskContextMethods = Task.prototype as unknown as {
	getContextWindowIndicator: () => ContextWindowIndicatorSnapshot | undefined
	restoreHistoricalContextWindowIndicator: (snapshot: TaskSnapshot | undefined) => void
	writeTaskSnapshot: (snapshot: TaskSnapshot) => Promise<void>
}
const getContextWindowIndicator = taskContextMethods.getContextWindowIndicator
const restoreHistoricalContextWindowIndicator = taskContextMethods.restoreHistoricalContextWindowIndicator
const writeTaskSnapshot = taskContextMethods.writeTaskSnapshot

function contextIndicator(taskId: string): ContextWindowIndicatorSnapshot {
	return {
		taskId,
		revision: 7,
		epoch: 2,
		phase: "stable",
		durableContextTokens: 40_000,
		pendingSendTokens: 0,
		receivingTokens: 0,
		stagedTokens: 2_000,
		environmentTokens: 1_000,
		contextWindow: 128_000,
		mode: "act",
		updatedAt: 100,
		lineage: { kind: "baseline" },
	}
}

describe("Task context indicator persistence", () => {
	let directory: string
	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "dline-context-snapshot-"))
		vi.stubEnv("DLINE_DOCS_DIR", directory)
	})
	afterEach(async () => {
		vi.unstubAllEnvs()
		await fs.rm(directory, { recursive: true, force: true })
	})

	it("attaches the current display snapshot through the existing writer without changing the runtime aggregate", async () => {
		const taskId = "saved-context-task"
		const indicator = contextIndicator(taskId)
		const runtime = { taskId, phase: TaskPhase.PAUSED, revision: 1, anchor: { apiIndex: -1 } }
		const snapshot = createSnapshot(runtime)
		const harness = {
			taskId,
			contextWindowIndicatorAvailable: true,
			taskState: { contextWindowIndicator: indicator },
			inputQueueCoordinator: {
				resolveSnapshotWrite: () => ({ kind: "write", entries: [] }),
				recordSnapshotWriteOutcome: vi.fn(),
			},
		}
		await writeTaskSnapshot.call(harness, snapshot)
		const taskDirectory = await ensureTaskDirectoryExists(taskId)
		const persisted = JSON.parse(
			await fs.readFile(path.join(taskDirectory, GlobalFileNames.taskSnapshot), "utf8"),
		) as TaskSnapshot
		expect(persisted.contextWindowIndicator).toEqual(indicator)
		expect(hydrateSnapshot(persisted)).toEqual(hydrateSnapshot(createSnapshot(runtime)))
		expect(snapshot).not.toHaveProperty("contextWindowIndicator")
	})

	it.each([
		["absent", undefined],
		["malformed", { taskId: "legacy-context-task", phase: "stable" }],
		["foreign", contextIndicator("another-task")],
	] as const)("keeps legacy totals separate when the historical segment snapshot is %s", (_name, savedIndicator) => {
		const taskId = "legacy-context-task"
		const contextWindowIndicator = new ContextWindowIndicator({
			taskId,
			durableContextTokens: 64_000,
			environmentTokens: 0,
			contextWindow: 128_000,
			mode: "act",
		})
		const harness = {
			taskId,
			contextWindowIndicator,
			contextWindowIndicatorAvailable: true,
			taskState: { contextWindowIndicator: contextWindowIndicator.getSnapshot() },
		}
		const snapshot = savedIndicator === undefined ? undefined : ({ contextWindowIndicator: savedIndicator } as TaskSnapshot)

		restoreHistoricalContextWindowIndicator.call(harness, snapshot)

		expect(getContextWindowIndicator.call(harness)).toBeUndefined()
		expect(harness.taskState.contextWindowIndicator).toBeUndefined()
	})

	it("does not persist a synthesized historical segment snapshot", async () => {
		const taskId = "legacy-context-task"
		const indicator = contextIndicator(taskId)
		const runtime = { taskId, phase: TaskPhase.PAUSED, revision: 1, anchor: { apiIndex: -1 } }
		const harness = {
			taskId,
			contextWindowIndicatorAvailable: false,
			taskState: { contextWindowIndicator: indicator },
			inputQueueCoordinator: {
				resolveSnapshotWrite: () => ({ kind: "write", entries: [] }),
				recordSnapshotWriteOutcome: vi.fn(),
			},
		}

		await writeTaskSnapshot.call(harness, createSnapshot(runtime))

		const taskDirectory = await ensureTaskDirectoryExists(taskId)
		const persisted = JSON.parse(
			await fs.readFile(path.join(taskDirectory, GlobalFileNames.taskSnapshot), "utf8"),
		) as TaskSnapshot
		expect(persisted).not.toHaveProperty("contextWindowIndicator")
	})
})
