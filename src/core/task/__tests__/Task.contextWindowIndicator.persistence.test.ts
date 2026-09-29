import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { ContextWindowIndicatorSnapshot } from "@shared/context-window-indicator"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ensureTaskDirectoryExists, GlobalFileNames } from "@/core/storage/disk"
import { Task } from "../index"
import { TaskPhase } from "../TaskPhase"
import { createSnapshot, hydrateSnapshot, type TaskSnapshot } from "../TaskSnapshot"

const writeTaskSnapshot = (
	Task.prototype as unknown as {
		writeTaskSnapshot: (snapshot: TaskSnapshot) => Promise<void>
	}
).writeTaskSnapshot

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
		const indicator: ContextWindowIndicatorSnapshot = {
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
		const runtime = { taskId, phase: TaskPhase.PAUSED, revision: 1, anchor: { apiIndex: -1 } }
		const snapshot = createSnapshot(runtime)
		const harness = {
			taskId,
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
})
