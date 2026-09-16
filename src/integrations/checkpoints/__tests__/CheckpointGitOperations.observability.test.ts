import path from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { DiagnosticDomain, DiagnosticOutcome } from "@/services/telemetry/instrumentation/diagnostic-events"

/**
 * Behavior guard for reporting how a checkpoint add ended.
 *
 * The failure branch previously recorded neither a metric nor a diagnostic, so
 * a checkpoint that could not be created was invisible to both Prometheus and
 * Loki. Users reported checkpoint creation failing under many tasks, and that
 * report could not be confirmed or located from telemetry.
 *
 * Reasons must stay bounded. The message of the underlying error is unbounded
 * and belongs in the log line, never in a metric dimension.
 */

const recorded = vi.hoisted(() => ({
	phases: [] as Array<{ domain: string; phase: string; dimensions?: Record<string, unknown> }>,
	diagnostics: [] as Array<{ domain: string; kind: string; outcome: string; dimensions?: Record<string, unknown> }>,
}))

/** Drives whether a tracked path is treated as present in the worktree. */
const worktree = vi.hoisted(() => ({ existingPaths: new Set<string>() }))

vi.mock("@utils/fs", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	fileExistsAtPath: async (target: string) => worktree.existingPaths.has(target),
}))

vi.mock("@/services/telemetry/instrumentation/duration-recorder", () => ({
	recordPerfPhase: (domain: string, phase: string, _durationMs: number, dimensions?: Record<string, unknown>) => {
		recorded.phases.push({ domain, phase, dimensions })
	},
	startPerfPhase: () => ({ stop: () => {}, active: false }),
	markPerfPhase: () => {},
}))

vi.mock("@/services/telemetry/instrumentation/diagnostic-recorder", () => ({
	recordDiagnostic: (domain: string, kind: string, outcome: string, dimensions?: Record<string, unknown>) => {
		recorded.diagnostics.push({ domain, kind, outcome, dimensions })
	},
}))

vi.mock("@/services/telemetry", () => ({ telemetryService: { captureCheckpointUsage: () => {} } }))

vi.mock("@/shared/services/Logger", () => ({
	Logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, log: () => {}, isDebugEnabled: () => false },
}))

const { GitOperations } = await import("../CheckpointGitOperations")

/** Reach the add path with collaborators stubbed to the branch under test. */
function createOperations(overrides: Record<string, unknown> = {}): {
	addCheckpointFiles: (options: {
		git: unknown
		mode: string
		fileList?: string[]
		taskId?: string
	}) => Promise<{ success: boolean }>
} {
	const operations = Object.create(GitOperations.prototype)
	Object.assign(operations, {
		cwd: "C:\\workspace",
		taskId: "task-1",
		boundaryDetector: { isInsideNestedRepository: async () => false },
		normalizeGitPath: (value: string) => value,
		...overrides,
	})
	return operations
}

beforeEach(() => {
	recorded.phases.length = 0
	recorded.diagnostics.length = 0
	worktree.existingPaths.clear()
})

/**
 * Built from the process working directory so the worktree-relative
 * calculation behaves the same on every platform.
 */
const WORKTREE = path.resolve("checkpoint-observability-worktree")
const TRACKED_FILE = path.join(WORKTREE, "src", "a.ts")

describe("checkpoint add observability", () => {
	it("reports a bounded reason when a mode receives an explicit file list it cannot accept", async () => {
		const operations = createOperations()

		const result = await operations.addCheckpointFiles({
			git: {},
			mode: "baseline",
			fileList: ["src/a.ts"],
			taskId: "task-1",
		})

		expect(result.success).toBe(false)
		const phase = recorded.phases.find((entry) => entry.phase === "add")
		expect(phase?.dimensions).toMatchObject({ outcome: "failure", reason: "invalid_request" })
		const diagnostic = recorded.diagnostics.find((entry) => entry.kind === "add_failed")
		expect(diagnostic?.domain).toBe(DiagnosticDomain.Checkpoint)
		expect(diagnostic?.outcome).toBe(DiagnosticOutcome.Failed)
		expect(diagnostic?.dimensions).toMatchObject({ reason: "invalid_request" })
	})

	it("reports a git error without letting the message reach a dimension", async () => {
		const git = {
			raw: async () => {
				throw new Error("fatal: unable to read C:\\workspace\\.git\\index")
			},
			add: async () => {
				throw new Error("fatal: unable to read C:\\workspace\\.git\\index")
			},
		}
		const operations = createOperations()

		const result = await operations.addCheckpointFiles({ git, mode: "baseline", taskId: "task-1" })

		expect(result.success).toBe(false)
		const phase = recorded.phases.find((entry) => entry.phase === "add")
		expect(phase?.dimensions).toMatchObject({ outcome: "failure", reason: "git_error" })
		// Every reported value has to come from the bounded enumeration.
		for (const value of Object.values(phase?.dimensions ?? {})) {
			expect(String(value)).not.toContain("fatal:")
		}
	})

	it("reports a successful workspace add with a success outcome", async () => {
		const git = { raw: async () => "", add: async () => undefined }
		const operations = createOperations()

		const result = await operations.addCheckpointFiles({ git, mode: "workspace-scan", taskId: "task-1" })

		expect(result.success).toBe(true)
		const phase = recorded.phases.find((entry) => entry.phase === "add")
		expect(phase?.dimensions).toMatchObject({ outcome: "success" })
		expect(phase?.dimensions).not.toHaveProperty("reason")
		expect(recorded.diagnostics.some((entry) => entry.kind === "add_failed")).toBe(false)
	})

	it("keeps every reported dimension bounded", async () => {
		const git = { raw: async () => "", add: async () => undefined }
		const operations = createOperations()

		await operations.addCheckpointFiles({ git, mode: "workspace-scan", taskId: "task-1" })

		const phase = recorded.phases.find((entry) => entry.phase === "add")
		const allowedOutcomes = new Set(["success", "partial", "nothing_to_stage", "failure"])
		expect(allowedOutcomes.has(String(phase?.dimensions?.outcome))).toBe(true)
		// A path count would grow without bound across workspaces.
		expect(phase?.dimensions).not.toHaveProperty("staged")
		expect(phase?.dimensions).not.toHaveProperty("rejected")
	})

	it("reports a tracked add that was given no files at all", async () => {
		const operations = createOperations()

		const result = await operations.addCheckpointFiles({ git: {}, mode: "tracked", fileList: [], taskId: "task-1" })

		expect(result.success).toBe(false)
		const phase = recorded.phases.find((entry) => entry.phase === "add")
		expect(phase?.dimensions).toMatchObject({ mode: "tracked", outcome: "failure", reason: "invalid_request" })
		expect(recorded.diagnostics.find((entry) => entry.kind === "add_failed")?.dimensions).toMatchObject({
			reason: "invalid_request",
		})
	})

	it("reports a tracked path that resolves outside the worktree", async () => {
		const operations = createOperations({ cwd: WORKTREE })
		const outsidePath = path.resolve(WORKTREE, "..", "elsewhere", "a.ts")

		const result = await operations.addCheckpointFiles({
			git: {},
			mode: "tracked",
			fileList: [outsidePath],
			taskId: "task-1",
		})

		expect(result.success).toBe(false)
		const phase = recorded.phases.find((entry) => entry.phase === "add")
		expect(phase?.dimensions).toMatchObject({ mode: "tracked", outcome: "failure", reason: "path_outside_worktree" })
		// The rejected path is unbounded and must stay out of the dimensions.
		for (const value of Object.values(phase?.dimensions ?? {})) {
			expect(String(value)).not.toContain("elsewhere")
		}
	})

	it("still reports an add whose tracked paths all belong to nested repositories", async () => {
		worktree.existingPaths.add(TRACKED_FILE)
		const operations = createOperations({
			cwd: WORKTREE,
			boundaryDetector: { isInsideNestedRepository: async () => true },
		})

		const result = await operations.addCheckpointFiles({
			git: { raw: async () => "", add: async () => undefined },
			mode: "tracked",
			fileList: [TRACKED_FILE],
			taskId: "task-1",
		})

		// Nothing could be staged, but the caller can still continue, so this is
		// not a failure. It must not vanish from the add rate either.
		expect(result.success).toBe(true)
		const phase = recorded.phases.find((entry) => entry.phase === "add")
		expect(phase?.dimensions).toMatchObject({ mode: "tracked", outcome: "nothing_to_stage" })
		expect(phase?.dimensions).not.toHaveProperty("reason")
		expect(recorded.diagnostics.some((entry) => entry.kind === "add_failed")).toBe(false)
		expect(recorded.diagnostics.some((entry) => entry.kind === "nested_repository_skipped")).toBe(true)
	})

	it("still reports an add whose tracked paths exist neither on disk nor in the index", async () => {
		const operations = createOperations({ cwd: WORKTREE })

		const result = await operations.addCheckpointFiles({
			git: { raw: async () => "", add: async () => undefined },
			mode: "tracked",
			fileList: [TRACKED_FILE],
			taskId: "task-1",
		})

		expect(result.success).toBe(true)
		const phase = recorded.phases.find((entry) => entry.phase === "add")
		expect(phase?.dimensions).toMatchObject({ mode: "tracked", outcome: "nothing_to_stage" })
		expect(recorded.diagnostics.some((entry) => entry.kind === "add_failed")).toBe(false)
		expect(recorded.diagnostics.some((entry) => entry.kind === "paths_unstageable")).toBe(true)
	})

	it("separates a partial staging result from a total staging rejection", async () => {
		const second = path.join(WORKTREE, "src", "b.ts")
		worktree.existingPaths.add(TRACKED_FILE)
		worktree.existingPaths.add(second)
		const partial = createOperations({
			cwd: WORKTREE,
			stageInBatches: async () => ({ stagedCount: 1, rejectedPaths: ["src/b.ts"] }),
		})

		const partialResult = await partial.addCheckpointFiles({
			git: { raw: async () => "", add: async () => undefined },
			mode: "tracked",
			fileList: [TRACKED_FILE, second],
			taskId: "task-1",
		})

		expect(partialResult.success).toBe(true)
		expect(recorded.phases.find((entry) => entry.phase === "add")?.dimensions).toMatchObject({
			outcome: "partial",
		})
		expect(recorded.diagnostics.some((entry) => entry.kind === "add_failed")).toBe(false)

		recorded.phases.length = 0
		recorded.diagnostics.length = 0
		const rejected = createOperations({
			cwd: WORKTREE,
			stageInBatches: async () => ({ stagedCount: 0, rejectedPaths: ["src/a.ts", "src/b.ts"] }),
		})

		const rejectedResult = await rejected.addCheckpointFiles({
			git: { raw: async () => "", add: async () => undefined },
			mode: "tracked",
			fileList: [TRACKED_FILE, second],
			taskId: "task-1",
		})

		expect(rejectedResult.success).toBe(false)
		expect(recorded.phases.find((entry) => entry.phase === "add")?.dimensions).toMatchObject({
			outcome: "failure",
			reason: "staging_rejected",
		})
		expect(recorded.diagnostics.find((entry) => entry.kind === "add_failed")?.dimensions).toMatchObject({
			reason: "staging_rejected",
		})
	})
})
