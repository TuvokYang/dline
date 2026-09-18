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
	const turnDriverSourcePath = path.resolve(__dirname, "../executors/tool/TurnDriver.ts")
	const toolExecutorSourcePath = path.resolve(__dirname, "../ToolExecutor.ts")
	const controllerSourcePath = path.resolve(__dirname, "../../controller/index.ts")
	const interactionCoordinatorSourcePath = path.resolve(__dirname, "../interaction/InteractionCoordinator.ts")

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

	it("fences interactions, publications, providers and tools before the Controller detaches Task ownership", async () => {
		const [taskSource, controllerSource, interactionSource] = await Promise.all([
			readFile(taskSourcePath, "utf8"),
			readFile(controllerSourcePath, "utf8"),
			readFile(interactionCoordinatorSourcePath, "utf8"),
		])
		const fenceMethod = taskSource.indexOf("public fenceControllerDetachment(): void")
		const ownershipFence = taskSource.indexOf("this.controllerDetached = true", fenceMethod)
		const interactionFence = taskSource.indexOf('this.interactionCoordinator.fence("task_detached")', fenceMethod)
		const hookAbort = taskSource.indexOf("this.taskState.activeHookExecution?.abortController.abort()", fenceMethod)
		const abortFence = taskSource.indexOf("this.taskState.abort = true", fenceMethod)
		expect(fenceMethod).toBeGreaterThan(-1)
		expect(ownershipFence).toBeGreaterThan(fenceMethod)
		expect(interactionFence).toBeGreaterThan(ownershipFence)
		expect(hookAbort).toBeGreaterThan(interactionFence)
		expect(abortFence).toBeGreaterThan(hookAbort)
		expect(taskSource.indexOf('this.taskState.cancelOperations("task_detached")', fenceMethod)).toBeGreaterThan(abortFence)
		expect(taskSource.indexOf("this.api?.abort?.()", fenceMethod)).toBeGreaterThan(abortFence)

		const continuation = taskSource.indexOf("private async continueRestoredInteraction(")
		const continuationFence = taskSource.indexOf("if (!context.isCurrent() || this.controllerDetached) return", continuation)
		const abortReset = taskSource.indexOf("this.taskState.abort = false", continuation)
		expect(continuationFence).toBeGreaterThan(continuation)
		expect(continuationFence).toBeLessThan(abortReset)

		const publishWrapper = taskSource.indexOf("this.postStateToWebview = async (options)")
		const publishFence = taskSource.indexOf("if (this.controllerDetached) return", publishWrapper)
		const realtimePush = taskSource.indexOf("pushMessage: (msg) => {")
		const realtimePushFence = taskSource.indexOf("if (this.controllerDetached) return", realtimePush)
		expect(publishWrapper).toBeGreaterThan(-1)
		expect(publishFence).toBeGreaterThan(publishWrapper)
		expect(realtimePush).toBeGreaterThan(-1)
		expect(realtimePushFence).toBeGreaterThan(realtimePush)

		const permanentFence = interactionSource.indexOf("fence(reason =")
		expect(permanentFence).toBeGreaterThan(-1)
		expect(interactionSource.indexOf("this.permanentlyFenced = true", permanentFence)).toBeGreaterThan(permanentFence)
		expect(interactionSource.indexOf("!this.permanentlyFenced", permanentFence)).toBeGreaterThan(permanentFence)

		const fenceCall = controllerSource.indexOf("task?.fenceControllerDetachment()")
		const detach = controllerSource.indexOf("this.task = undefined", fenceCall)
		expect(fenceCall).toBeGreaterThan(-1)
		expect(detach).toBeGreaterThan(fenceCall)
	})

	it("keeps ToolExecutor abort guards ahead of telemetry, canonicalization, browser and handler side effects", async () => {
		const source = await readFile(toolExecutorSourcePath, "utf8")
		const publicStart = source.indexOf("public async executeTool(block: ToolUse)")
		const publicAbort = source.indexOf("if (this.taskState.abort) return", publicStart)
		const spanStart = source.indexOf("const span = startSignalSpan", publicStart)
		expect(publicStart).toBeGreaterThan(-1)
		expect(publicAbort).toBeGreaterThan(publicStart)
		expect(publicAbort).toBeLessThan(spanStart)

		const privateStart = source.indexOf("private async execute(block: ToolUse")
		const privateAbort = source.indexOf("if (this.taskState.abort) return true", privateStart)
		const canonicalize = source.indexOf("canonicalizeAttemptCompletionParams(block)", privateStart)
		const browserClose = source.indexOf("await this.browserSession.closeBrowser()", privateStart)
		const postBrowserAbort = source.indexOf("if (this.taskState.abort) return true", browserClose)
		const partialHandler = source.indexOf("await this.handlePartialBlock(block, config)", browserClose)
		const completeHandler = source.indexOf("await this.handleCompleteBlock(block, config)", browserClose)
		expect(privateStart).toBeGreaterThan(-1)
		expect(privateAbort).toBeGreaterThan(privateStart)
		expect(privateAbort).toBeLessThan(canonicalize)
		expect(privateAbort).toBeLessThan(browserClose)
		expect(postBrowserAbort).toBeGreaterThan(browserClose)
		expect(postBrowserAbort).toBeLessThan(partialHandler)
		expect(postBrowserAbort).toBeLessThan(completeHandler)

		const hookMethod = source.indexOf("private async runPostToolUseHook(")
		const hookImport = source.indexOf('await import("../hooks/hook-executor")', hookMethod)
		const postImportAbort = source.indexOf("if (this.taskState.abort) return false", hookImport)
		const hookExecution = source.indexOf("const postToolResult = await executeHook(", hookImport)
		const postExecutionHookAbort = source.indexOf("if (this.taskState.abort) return false", hookExecution)
		const hookResultHandling = source.indexOf("if (postToolResult.cancel === true)", hookExecution)
		expect(hookMethod).toBeGreaterThan(-1)
		expect(postImportAbort).toBeGreaterThan(hookImport)
		expect(postImportAbort).toBeLessThan(hookExecution)
		expect(postExecutionHookAbort).toBeGreaterThan(hookExecution)
		expect(postExecutionHookAbort).toBeLessThan(hookResultHandling)

		const completeStart = source.indexOf("private async handleCompleteBlock(")
		const coordinatorExecute = source.indexOf("await this.coordinator.execute(config, block)", completeStart)
		const postExecutionAbort = source.indexOf("if (this.taskState.abort)", coordinatorExecute)
		const resultCommit = source.indexOf("await this.commitToolResult(toolResult, block)", coordinatorExecute)
		const postCommitAbort = source.indexOf("if (this.taskState.abort) return", resultCommit)
		const loopTracking = source.indexOf("const currentSignature = toolCallSignature", resultCommit)
		expect(completeStart).toBeGreaterThan(-1)
		expect(coordinatorExecute).toBeGreaterThan(completeStart)
		expect(postExecutionAbort).toBeGreaterThan(coordinatorExecute)
		expect(postExecutionAbort).toBeLessThan(resultCommit)
		expect(postCommitAbort).toBeGreaterThan(resultCommit)
		expect(postCommitAbort).toBeLessThan(loopTracking)

		const successHook = source.indexOf("await this.runPostToolUseHook(", loopTracking)
		const postHookAbort = source.indexOf("if (this.taskState.abort) return", successHook)
		const hookCancellation = source.indexOf("if (hookRequestedCancel)", successHook)
		expect(successHook).toBeGreaterThan(loopTracking)
		expect(postHookAbort).toBeGreaterThan(successHook)
		expect(postHookAbort).toBeLessThan(hookCancellation)
	})

	it("gates mutating partial presentation and finalized execution before ToolExecutor side effects", async () => {
		const source = await readFile(taskSourcePath, "utf8")
		const helper = source.indexOf("private async awaitInitialCheckpointBeforeToolSideEffects")
		expect(helper).toBeGreaterThan(-1)
		expect(source.indexOf("READ_ONLY_TOOLS.includes(toolName as any)", helper)).toBeGreaterThan(helper)

		const reRenderStart = source.indexOf("private async reRenderUpdatedPartialBlocks", helper)
		const reRenderGate = source.indexOf("await this.awaitInitialCheckpointBeforeToolSideEffects(block.name)", reRenderStart)
		const reRenderAbortFence = source.indexOf("if (this.taskState.abort) return", reRenderGate)
		const reRenderEffect = source.indexOf("await this.toolExecutor.reRenderPartialBlock", reRenderStart)
		expect(reRenderGate).toBeGreaterThan(reRenderStart)
		expect(reRenderAbortFence).toBeGreaterThan(reRenderGate)
		expect(reRenderAbortFence).toBeLessThan(reRenderEffect)

		const presentationStart = source.indexOf("async presentAssistantMessage(", reRenderStart)
		const partialGate = source.indexOf(
			"await this.awaitInitialCheckpointBeforeToolSideEffects(block.name)",
			presentationStart,
		)
		const partialAbortFence = source.indexOf("if (this.taskState.abort) return", partialGate)
		const partialEffect = source.indexOf("await this.toolExecutor.executeTool(block)", presentationStart)
		expect(partialGate).toBeGreaterThan(presentationStart)
		expect(partialAbortFence).toBeGreaterThan(partialGate)
		expect(partialAbortFence).toBeLessThan(partialEffect)

		const turnDriverSource = await readFile(turnDriverSourcePath, "utf8")
		const finalizationStart = turnDriverSource.indexOf("async execute(")
		const finalizationGate = turnDriverSource.indexOf(
			"await this.ports.block.awaitInitialCheckpoint(tool.name)",
			finalizationStart,
		)
		const finalizationAbortFence = turnDriverSource.indexOf(
			'if (this.ports.task.isAborted()) return "halt_turn"',
			finalizationGate,
		)
		const finalizationEffect = turnDriverSource.indexOf('type: "BLOCK_EXECUTION_STARTED"', finalizationStart)
		expect(finalizationGate).toBeGreaterThan(finalizationStart)
		expect(finalizationAbortFence).toBeGreaterThan(finalizationGate)
		expect(finalizationAbortFence).toBeLessThan(finalizationEffect)
	})
})
