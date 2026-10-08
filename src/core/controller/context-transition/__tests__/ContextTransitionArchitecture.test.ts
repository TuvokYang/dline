import { readFile } from "node:fs/promises"
import path from "node:path"
import { describe, expect, it } from "vitest"

const root = path.resolve("src/core")

async function read(relativePath: string): Promise<string> {
	return readFile(path.join(root, relativePath), "utf8")
}

/** Lock the approved transition ownership and interaction boundaries. */
describe("ContextTransition architecture", () => {
	it("uses one engine as the only Profile and Mode transaction state owner", async () => {
		const [engine, modeAdapter, profileAdapter] = await Promise.all([
			read("controller/context-transition/ContextTransitionEngine.ts").catch(() => ""),
			read("controller/mode-switch/ModeSwitchCoordinator.ts"),
			read("controller/profile-switch/ProfileSwitchCoordinator.ts"),
		])

		expect(engine).toContain("export class ContextTransitionEngine")
		expect(modeAdapter).toContain("ContextTransitionEngine")
		expect(profileAdapter).toContain("ContextTransitionEngine")
		expect(modeAdapter).not.toMatch(/private\s+(?:readonly\s+)?(?:snapshot|operation)\b/)
		expect(profileAdapter).not.toMatch(/private\s+(?:readonly\s+)?(?:snapshot|operation)\b/)
	})

	it("keeps a Profile switch free of target projection and compaction", async () => {
		const [controller, coordinator, policy] = await Promise.all([
			read("controller/index.ts"),
			read("controller/profile-switch/ProfileSwitchCoordinator.ts"),
			read("controller/context-transition/policies/ProfileTransitionPolicy.ts"),
		])

		// Selecting a Profile only rebinds handlers, so no Profile path may rebuild a
		// target request or schedule compaction: both once blocked the switch outright.
		// Occupancy is read from the live indicator by the Controller, which owns the
		// transition; the Task side no longer projects a target usage request.
		expect(controller).toContain("getOccupiedContextTokens()")
		expect(controller).not.toContain("projectProfileSwitchTargetUsage")
		expect(coordinator).not.toContain("projectProfileSwitchTargetUsage")
		expect(policy).not.toContain("createCompactionRequest")
		expect(policy).not.toContain("compactionError")
	})

	it("keeps the context-window indicator free of compact checkpoint and restore lineage", async () => {
		const [schema, indicator, progress] = await Promise.all([
			read("../shared/context-window-indicator.ts"),
			read("task/ContextWindowIndicator.ts"),
			read("../../webview-ui/src/components/chat/task-header/ContextWindowSegmentedProgress.tsx"),
		])

		for (const source of [schema, indicator]) {
			expect(source).not.toContain('kind: "checkpoint"')
			expect(source).not.toContain('kind: "restore"')
			expect(source).not.toContain("checkpointId")
			expect(source).not.toContain("headCheckpointId")
			expect(source).not.toContain("chainRevision")
			expect(source).not.toContain("branchId")
			expect(source).not.toContain("journalId")
		}
		expect(schema).not.toContain('"restoring"')
		expect(indicator).not.toContain("recoverCommit(")
		expect(progress).not.toContain('"restore"')
	})

	it("keeps conversational handlers and interaction ownership unaware of compaction control signals", async () => {
		const paths = [
			// Canonical interaction ownership after the runtime convergence.
			"task/interaction/InteractionRegistry.ts",
			"task/interaction/InteractionContinuation.ts",
			"task/session/TaskInteractionOwner.ts",
			"task/tools/handlers/AskFollowupQuestionToolHandler.ts",
			"task/tools/handlers/AttemptCompletionHandler.ts",
			"task/tools/handlers/GenerateReportHandler.ts",
			"task/tools/handlers/MakePlanHandler.ts",
			"task/tools/handlers/QnaRespondHandler.ts",
			"task/tools/handlers/StatusUpdateHandler.ts",
		]
		const sources = await Promise.all(paths.map(read))

		for (const source of sources) {
			expect(source).not.toContain("respondForModeCompaction")
			expect(source).not.toContain("MODE_SWITCH_COMPACT_SIGNAL")
			expect(source).not.toContain("isCompactSignal")
			expect(source).not.toContain("CONTEXT_TRANSITION_COMPACTION_RESULT")
		}
	})
})
