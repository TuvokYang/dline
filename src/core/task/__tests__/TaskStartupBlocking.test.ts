import { readFile } from "fs/promises"
import path from "path"
import { describe, expect, it } from "vitest"

/**
 * `startTask` runs before the first `say`, so every await inside it is invisible
 * in production logs. `refreshStableContextWindowIndicator` builds full
 * environment details (host version, visible tabs, open tabs, active task
 * controllers) purely to refresh a header readout, and nothing downstream reads
 * its result. Awaiting it delayed the first provider request on large
 * workspaces, which is why it must stay off the startup critical path.
 */
describe("Task startup blocking", () => {
	const taskSourcePath = path.resolve(__dirname, "../index.ts")

	async function readStartTaskBody(): Promise<string> {
		const source = await readFile(taskSourcePath, "utf8")
		const start = source.indexOf("public async startTask(")
		expect(start).toBeGreaterThan(-1)
		const end = source.indexOf('await this.say("task"', start)
		expect(end).toBeGreaterThan(start)
		return source.slice(start, end)
	}

	it("does not await the stable context-window indicator before the first say", async () => {
		const body = await readStartTaskBody()

		expect(body).not.toContain("await this.refreshStableContextWindowIndicator()")
		expect(body).toContain("void this.refreshStableContextWindowIndicator()")
	})

	it("keeps the background refresh failure-tolerant", async () => {
		const body = await readStartTaskBody()

		const refreshIndex = body.indexOf("void this.refreshStableContextWindowIndicator()")
		const catchIndex = body.indexOf(".catch(", refreshIndex)

		expect(catchIndex).toBeGreaterThan(refreshIndex)
	})

	it("reports startup segment timings so a stall is attributable from logs", async () => {
		const body = await readStartTaskBody()

		expect(body).toContain("startTask timing:")
		expect(body).toContain("rateMetrics=")
		expect(body).toContain("clineIgnore=")
	})

	/**
	 * The checkpoint baseline must capture the workspace before the model can edit
	 * any file, but provider inference itself is read-only. Initialization can run
	 * concurrently with the first request as long as every mutating tool awaits the
	 * durable baseline promise before execution.
	 */
	it("does not await checkpoint initialization before the first provider request", async () => {
		const source = await readFile(taskSourcePath, "utf8")
		const start = source.indexOf("async recursivelyMakeClineRequests(")
		expect(start).toBeGreaterThan(-1)
		const end = source.indexOf("// Determine if we should compact context window", start)
		expect(end).toBeGreaterThan(start)
		const method = source.slice(start, end)

		expect(method).toContain("checkpointInitializationPromise = ensureCheckpointInitialized({ checkpointManager })")
		expect(method).not.toContain("await ensureCheckpointInitialized(")
		expect(method).toContain("this.initialCheckpointCommitPromise = persistCommitPromise")
	})

	it("skips the post-turn workspace checkpoint when every tool is read-only", async () => {
		const source = await readFile(taskSourcePath, "utf8")
		const helperStart = source.indexOf("private assistantTurnMayModifyWorkspace")
		expect(helperStart).toBeGreaterThan(-1)
		const helperEnd = source.indexOf("/**", helperStart + 1)
		const helper = source.slice(helperStart, helperEnd)

		expect(helper).toContain('block.type === "tool_use"')
		expect(helper).toContain("!READ_ONLY_TOOLS.includes(block.name as any)")

		const checkpointComment = source.indexOf("// Read-only turns cannot change workspace state.")
		const checkpointGate = source.indexOf("if (this.assistantTurnMayModifyWorkspace())", checkpointComment)
		const checkpointSave = source.indexOf("await this.checkpointManager?.saveCheckpoint()", checkpointComment)
		expect(checkpointGate).toBeGreaterThan(checkpointComment)
		expect(checkpointGate).toBeLessThan(checkpointSave)
	})

	it("gates mutating partial presentation and finalized execution before ToolExecutor side effects", async () => {
		const source = await readFile(taskSourcePath, "utf8")
		const helper = source.indexOf("private async awaitInitialCheckpointBeforeToolSideEffects")
		expect(helper).toBeGreaterThan(-1)
		expect(source.indexOf("READ_ONLY_TOOLS.includes(toolName as any)", helper)).toBeGreaterThan(helper)

		const reRenderStart = source.indexOf("private async reRenderUpdatedPartialBlocks", helper)
		const reRenderGate = source.indexOf("await this.awaitInitialCheckpointBeforeToolSideEffects(block.name)", reRenderStart)
		const reRenderEffect = source.indexOf("await this.toolExecutor.reRenderPartialBlock", reRenderStart)
		expect(reRenderGate).toBeGreaterThan(reRenderStart)
		expect(reRenderGate).toBeLessThan(reRenderEffect)

		const presentationStart = source.indexOf("async presentAssistantMessage(", reRenderStart)
		const partialGate = source.indexOf(
			"await this.awaitInitialCheckpointBeforeToolSideEffects(block.name)",
			presentationStart,
		)
		const partialEffect = source.indexOf("await this.toolExecutor.executeTool(block)", presentationStart)
		expect(partialGate).toBeGreaterThan(presentationStart)
		expect(partialGate).toBeLessThan(partialEffect)

		const finalizationStart = source.indexOf("private async executeFinalizedAssistantTurn", presentationStart)
		const finalizationGate = source.indexOf(
			"await this.awaitInitialCheckpointBeforeToolSideEffects(tool.name)",
			finalizationStart,
		)
		const finalizationEffect = source.indexOf('type: "BLOCK_EXECUTION_STARTED"', finalizationStart)
		expect(finalizationGate).toBeGreaterThan(finalizationStart)
		expect(finalizationGate).toBeLessThan(finalizationEffect)
	})
})
