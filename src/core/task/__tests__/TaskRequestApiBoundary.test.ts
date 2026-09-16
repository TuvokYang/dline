import { readFile } from "node:fs/promises"
import path from "node:path"
import { describe, expect, it } from "vitest"

const taskSourcePath = path.resolve("src/core/task/index.ts")

function extractMethod(source: string, startMarker: string, endMarker: string): string {
	const start = source.indexOf(startMarker)
	const end = source.indexOf(endMarker, start)
	if (start < 0 || end < 0) {
		throw new Error(`Unable to locate Task request boundary: ${startMarker}`)
	}
	return source.slice(start, end)
}

describe("Task request API boundary", () => {
	it("builds the replacement handler before aborting and committing the previous handler", async () => {
		const source = await readFile(taskSourcePath, "utf8")
		const method = extractMethod(source, "public async rebuildApiHandler(", "/** Capture the handler fields")
		const previousCapture = method.indexOf("const previousApi = this.api")
		const nextBuild = method.indexOf("const nextApi =")
		const conditionalAbort = method.indexOf("options.abortPrevious === true || !this.taskState.isStreaming")
		const oldAbort = method.indexOf("previousApi.abort?.()", conditionalAbort)
		const commit = method.indexOf("this.api = nextApi")

		expect(previousCapture).toBeGreaterThanOrEqual(0)
		expect(nextBuild).toBeGreaterThan(previousCapture)
		expect(conditionalAbort).toBeGreaterThan(nextBuild)
		expect(oldAbort).toBeGreaterThan(conditionalAbort)
		expect(commit).toBeGreaterThan(oldAbort)
	})

	it("refreshes the latest Profile before freezing the request API scope", async () => {
		const source = await readFile(taskSourcePath, "utf8")
		const method = extractMethod(source, "async recursivelyMakeClineRequests(", "async loadContext(")
		const transitionIndex = method.indexOf("const transitionScope = this.modeSwitchCompaction.getExecutionScope()")
		const refreshIndex = method.indexOf("await this.rebuildApiHandler({ validateCredentials: true })")
		const requestLocalAwaitIndex = method.indexOf("await this.remoteWorkspaceDetectionPromise")
		const scopeIndex = method.indexOf("const requestScope = createRequestApiScope(")

		expect(transitionIndex).toBeGreaterThanOrEqual(0)
		expect(refreshIndex).toBeGreaterThan(transitionIndex)
		expect(method).toContain('? { status: "valid" }\n\t\t\t: await this.rebuildApiHandler({ validateCredentials: true })')
		expect(requestLocalAwaitIndex).toBeGreaterThan(refreshIndex)
		expect(scopeIndex).toBeGreaterThan(requestLocalAwaitIndex)
	})

	it("lets an explicit manual compaction command reach slash-command parsing before auto compaction", async () => {
		const source = await readFile(taskSourcePath, "utf8")
		const method = extractMethod(source, "async recursivelyMakeClineRequests(", "async loadContext(")
		const manualIntentIndex = method.indexOf("hasManualCompactionIntent(userContent,")
		const autoCompactionIndex = method.indexOf("this.contextManager.shouldCompactContextWindow(")

		expect(manualIntentIndex).toBeGreaterThanOrEqual(0)
		expect(autoCompactionIndex).toBeGreaterThan(manualIntentIndex)
		expect(method).toContain("!manualCompactionRequested")
	})

	it("runs final admission and may start compaction for a restored durable request without preprocessing it again", async () => {
		const source = await readFile(taskSourcePath, "utf8")
		const method = extractMethod(source, "async recursivelyMakeClineRequests(", "async loadContext(")
		const compactionCapability = method.indexOf(
			"const canCompactBeforeAdmission = transaction.beforeApiRequestStarted === undefined",
		)
		const coarseAutomaticSession = method.indexOf("if (shouldCompact && !manualCompactionRequested)", compactionCapability)
		const manualSession = method.indexOf("if (manualCompactionRequested && this.taskState.isManualContextCompactionRequest)")
		const persistedCandidate = method.indexOf("buildPersistedRequestCandidate(", manualSession)
		const finalGuard = method.indexOf("await this.evaluateFinalContextWindowGuard(", persistedCandidate)
		const finalAutomaticSession = method.indexOf("await this.runOrdinaryContextCompaction(", finalGuard)

		expect(compactionCapability).toBeGreaterThanOrEqual(0)
		expect(coarseAutomaticSession).toBeGreaterThan(compactionCapability)
		expect(manualSession).toBeGreaterThan(coarseAutomaticSession)
		expect(persistedCandidate).toBeGreaterThan(manualSession)
		expect(finalGuard).toBeGreaterThan(persistedCandidate)
		expect(finalAutomaticSession).toBeGreaterThan(finalGuard)
		expect(method.slice(compactionCapability, manualSession)).not.toContain("deferCurrentTurn(")
	})

	it("parses mentions and manual compaction only from canonically paired user feedback", async () => {
		const source = await readFile(taskSourcePath, "utf8")
		const method = extractMethod(source, "async loadContext(", "async getEnvironmentDetails(")
		const toolResultBranchStart = method.indexOf('if (block.type === "tool_result")')
		const toolResultBranch = method.slice(toolResultBranchStart)

		expect(toolResultBranchStart).toBeGreaterThanOrEqual(0)
		expect(toolResultBranch).toContain("this.isTrustedUserFeedbackResult(block)")
		expect(toolResultBranch).toContain("hasManualCompactionIntent([block], () => true)")
		expect(toolResultBranch).toContain("processUserContentTags(")
		expect(toolResultBranch).toContain("parseTextBlock(text, parseTrustedManualCompaction)")
		expect(toolResultBranch).not.toContain("parseMentions(")
	})

	it("pairs trusted feedback by canonical identities and conversational tool admission", async () => {
		const source = await readFile(taskSourcePath, "utf8")
		const method = extractMethod(
			source,
			"private isTrustedUserFeedbackResult(",
			"private async persistApiRequestUserMessage(",
		)

		expect(method).toContain("candidate.function_id === block.function_id")
		expect(method).toContain("candidate.dline_tid === block.dline_tid")
		expect(method).toContain("CONVERSATIONAL_TOOL_NAMES.has")
	})

	it("resumes a durable Hosted request without repeating preprocessing, history append, or approval", async () => {
		const source = await readFile(taskSourcePath, "utf8")
		const method = extractMethod(source, "async recursivelyMakeClineRequests(", "async loadContext(")
		const persistedIndex = method.indexOf("const persistedRequestApiIndex = transaction.persistedRequestApiIndex")
		const tailValidation = method.indexOf(
			"persistedRequestApiIndex !== this.messageStateHandler.apiConversationHistory.length - 1",
		)
		const newRequestPlaceholder = method.indexOf("if (!persistedRequest) {\n\t\t\tawait this.say(")
		const gateSelection = method.indexOf("let requestApproved: boolean")
		const retryAdmission = method.indexOf("if (persistedRequest) {\n\t\t\tawait this.admitApiRequest(apiIndex)")
		const ordinaryPersistence = method.indexOf("requestApproved = await this.persistApiRequestUserMessage(")

		expect(persistedIndex).toBeGreaterThanOrEqual(0)
		expect(tailValidation).toBeGreaterThan(persistedIndex)
		expect(newRequestPlaceholder).toBeGreaterThan(tailValidation)
		expect(gateSelection).toBeGreaterThan(newRequestPlaceholder)
		expect(retryAdmission).toBeGreaterThan(gateSelection)
		expect(ordinaryPersistence).toBeGreaterThan(retryAdmission)
		expect(method).toContain("if (persistedRequest) {\n\t\t\tparsedUserContent = userContent")
		expect(method).toContain("if (!persistedRequest && !shouldCompact)")
		expect(method).toContain("buildPersistedRequestCandidate(")
		expect(method).toContain("persistedRequestApiIndex")
	})

	it("does not mutate the current ordinary turn before handing compaction to the Session", async () => {
		const source = await readFile(taskSourcePath, "utf8")
		const method = extractMethod(source, "async recursivelyMakeClineRequests(", "async loadContext(")

		expect(method).toContain("await this.runOrdinaryContextCompaction(")
		expect(method).not.toContain("deferCurrentTurn(")
		expect(method).not.toContain("prepareModeSwitchCompaction(")
		expect(method).not.toContain("overwriteApiConversationHistory(")
	})

	it("drops all completed middle turns before a forced source-mode summary", async () => {
		const source = await readFile(taskSourcePath, "utf8")
		const method = extractMethod(source, "private async prepareModeSwitchCompaction(", "/** Merge a confirmation-owned draft")

		expect(method).toContain('"none"')
		expect(method).not.toContain('"lastTwo"')
	})

	it("restores the deferred tool turn before releasing the mode-switch commit barrier", async () => {
		const source = await readFile(taskSourcePath, "utf8")
		const method = extractMethod(source, "async recursivelyMakeClineRequests(", "async loadContext(")
		const restoreCall = method.indexOf("await this.restoreDeferredTurn(userContent)")
		const markAppliedCall = method.indexOf("await this.modeSwitchCompaction.markApplied()")

		expect(restoreCall).toBeGreaterThanOrEqual(0)
		expect(markAppliedCall).toBeGreaterThan(restoreCall)
	})

	it("preserves a prepared mode-compaction tail across the context-length retry", async () => {
		const source = await readFile(taskSourcePath, "utf8")
		const method = extractMethod(
			source,
			"private async handleContextWindowExceededError(",
			"/**\n\t * Build the current system prompt",
		)

		expect(method).toContain(
			"if (!(this.modeSwitchCompaction.shouldForce() && this.taskState.conversationHistoryDeletedRange))",
		)
	})

	it("reports the request-selected API format in final usage telemetry", async () => {
		const source = await readFile(taskSourcePath, "utf8")
		const method = extractMethod(source, "async recursivelyMakeClineRequests(", "async loadContext(")

		expect(method).toContain("apiFormat: requestScope.selectedApiFormat")
		expect(method).not.toContain("apiFormat: model.info.apiFormats?.[0]")
	})

	it("does not read the mutable handler after creating the request scope", async () => {
		const source = await readFile(taskSourcePath, "utf8")
		const method = extractMethod(source, "async recursivelyMakeClineRequests(", "async loadContext(")
		const scopeIndex = method.indexOf("const requestScope = createRequestApiScope(")
		const scopeEndIndex = method.indexOf("\n\t\t)\n", scopeIndex)
		const requestBody = method.slice(scopeEndIndex + "\n\t\t)\n".length)

		expect(scopeEndIndex).toBeGreaterThan(scopeIndex)
		expect(requestBody).not.toMatch(/\bthis\.api\b/)
	})

	it("resolves the compaction output budget only inside the explicit Pass builder", async () => {
		const source = await readFile(taskSourcePath, "utf8")
		const passBuilder = extractMethod(
			source,
			"private async buildContextCompactionPassRequest(",
			"/** Rebuild the complete target candidate",
		)
		const ordinaryBuilder = extractMethod(
			source,
			"private async buildProviderInput(",
			"/** Build the exact ordinary candidate",
		)
		const sessionFactory = extractMethod(
			source,
			"private createContextCompactionSession(): ContextCompactionSession",
			"private async settleContextCompactionIndicator",
		)

		expect(sessionFactory).toContain("state.nextPassSummaryCarryLimitTokens")
		expect(sessionFactory).toContain('"estimate"')
		expect(passBuilder).toContain('purpose: "send" | "estimate" = "send"')
		expect(passBuilder).toContain("resolveCompactionWindowBudget({")
		expect(passBuilder).toContain("summaryOutputLimitTokens,")
		expect(passBuilder).toContain("providerOutputCap: resolvedBudget.budget.providerOutputCap")
		expect(ordinaryBuilder).not.toContain("resolveCompactionWindowBudget({")
		expect(ordinaryBuilder).toContain("providerOutputCap: undefined")
	})

	it("registers every Session Pass internally without ordinary request replay", async () => {
		const source = await readFile(taskSourcePath, "utf8")
		const method = extractMethod(
			source,
			"private async buildContextCompactionPassRequest(",
			"/** Rebuild the complete target candidate",
		)
		const registrationStart = method.indexOf("requestScope.explicitInstructions.register({")
		const candidateStart = method.indexOf("const buildCandidateHistory =", registrationStart)
		const providerStart = method.indexOf("await this.buildProviderInput(", candidateStart)

		expect(registrationStart).toBeGreaterThanOrEqual(0)
		expect(candidateStart).toBeGreaterThan(registrationStart)
		expect(providerStart).toBeGreaterThan(candidateStart)
		expect(method).toContain('type: "summarize_task"')
		expect(method).toContain("targetTool: ClineDefaultTool.SUMMARIZE_TASK")
		expect(method).not.toContain("compactionRequestReplay")
		expect(method).not.toContain("persistApiRequestUserMessage(")
	})

	it("maps automatic, manual, Header, Profile, and Mode compaction at dedicated Session entrances", async () => {
		const source = await readFile(taskSourcePath, "utf8")

		expect(source).toContain('trigger: "auto_compaction"')
		expect(source).toContain('trigger: "manual_compact_command"')
		expect(source).toContain('trigger: "task_header"')
		expect(source).toContain('trigger: "profile_switch" | "mode_switch"')
		expect(source).not.toContain("const compactionDeclaration = {")
	})

	it("classifies Header and slash-command Passes as manual in the Session event owner", async () => {
		const source = await readFile(taskSourcePath, "utf8")
		const method = extractMethod(
			source,
			"private async publishContextCompactionEvent(",
			"/** Apply one explicit legacy history truncation",
		)
		const classificationStart = method.indexOf(
			'const isManual = input.trigger === "task_header" || input.trigger === "manual_compact_command"',
		)
		const manualAssignment = method.indexOf("this.taskState.isManualContextCompactionRequest = isManual", classificationStart)
		const internalAssignment = method.indexOf(
			"this.taskState.isInternalContextCompactionRequest = !isManual",
			manualAssignment,
		)

		expect(classificationStart).toBeGreaterThanOrEqual(0)
		expect(manualAssignment).toBeGreaterThan(classificationStart)
		expect(internalAssignment).toBeGreaterThan(manualAssignment)
	})

	it("does not project internal authorization IDs into provider messages", async () => {
		const source = await readFile(taskSourcePath, "utf8")
		const method = extractMethod(source, "async *attemptApiRequest(", "// Block identity is now assigned")

		expect(method).not.toContain("rewriteProviderInstructionIds(")
		expect(method).not.toContain("rewriteInstructionIds")
		expect(method).not.toContain("instruction_id")
	})

	it("does not create a synthetic compaction row before provider content or a terminal status", async () => {
		const source = await readFile(taskSourcePath, "utf8")
		const method = extractMethod(source, "async recursivelyMakeClineRequests(", "async loadContext(")

		expect(method).not.toContain("ensureContextCompactionStatusRow(")
		expect(method).not.toContain('updateContextCompactionStatus("running"')
	})

	it("normalizes authorized compaction text for streaming parsing and final persistence", async () => {
		const source = await readFile(taskSourcePath, "utf8")
		const method = extractMethod(source, "async recursivelyMakeClineRequests(", "async loadContext(")
		const streamingNormalization = method.indexOf("normalizeCompactionResponse(assistantMessage).assistantText")
		const parseIndex = method.indexOf("parseAssistantMessageV2(assistantMessageForParsing", streamingNormalization)
		const finalMessageNormalization = method.indexOf(
			"assistantMessage = normalizeCompactionResponse(assistantMessage).assistantText",
			parseIndex,
		)
		const finalTextNormalization = method.indexOf(
			"assistantTextOnly = normalizeCompactionResponse(assistantTextOnly).assistantText",
			finalMessageNormalization,
		)
		const historyAppend = method.indexOf("addToApiConversationHistory({", finalTextNormalization)

		expect(streamingNormalization).toBeGreaterThanOrEqual(0)
		expect(parseIndex).toBeGreaterThan(streamingNormalization)
		expect(finalMessageNormalization).toBeGreaterThan(parseIndex)
		expect(finalTextNormalization).toBeGreaterThan(finalMessageNormalization)
		expect(historyAppend).toBeGreaterThan(finalTextNormalization)
	})

	it("cleans failed compaction attempts before protocol-specific or ordinary retry decisions", async () => {
		const source = await readFile(taskSourcePath, "utf8")
		const providerMethod = extractMethod(source, "async *attemptApiRequest(", "// Block identity is now assigned")
		const requestMethod = extractMethod(source, "async recursivelyMakeClineRequests(", "async loadContext(")

		const firstChunkDecision = providerMethod.indexOf("const openAiMaxOutputReplayDecision")
		const firstChunkCleanup = providerMethod.indexOf(
			"await this.discardFailedCompactionAttempt(apiIndex)",
			firstChunkDecision,
		)
		const firstChunkOrdinaryClassification = providerMethod.indexOf("const isContextWindowExceededError", firstChunkCleanup)
		const streamDecision = requestMethod.indexOf("const openAiMaxOutputReplayDecision")
		const streamCleanup = requestMethod.lastIndexOf("await this.discardFailedCompactionAttempt(apiIndex)", streamDecision)
		const streamOrdinaryClassification = requestMethod.indexOf(
			"const retryDecision = getStreamRetryDecision({",
			streamDecision,
		)

		expect(firstChunkDecision).toBeGreaterThanOrEqual(0)
		expect(firstChunkCleanup).toBeGreaterThan(firstChunkDecision)
		expect(firstChunkOrdinaryClassification).toBeGreaterThan(firstChunkCleanup)
		expect(streamCleanup).toBeGreaterThanOrEqual(0)
		expect(streamDecision).toBeGreaterThan(streamCleanup)
		expect(streamOrdinaryClassification).toBeGreaterThan(streamDecision)
	})

	it("waits for the failed stream lifecycle to close before dispatching an OpenAI max-output replay", async () => {
		const source = await readFile(taskSourcePath, "utf8")
		const method = extractMethod(
			source,
			"private scheduleCompactionReplay(",
			"/** Continue Task-owned recovery after an automatic compaction attempt has been fully discarded. */",
		)
		const releaseBarrier = method.indexOf("pWaitFor(() => !this.taskState.isStreaming")
		const currentTaskGuard = method.indexOf("if (this.controller.task !== this || this.taskState.abort) return")
		const dispatch = method.indexOf('this.dispatchRuntime({ type: "API_RETRY_SCHEDULED", apiIndex })')

		expect(releaseBarrier).toBeGreaterThanOrEqual(0)
		expect(currentTaskGuard).toBeGreaterThan(releaseBarrier)
		expect(dispatch).toBeGreaterThan(currentTaskGuard)
		expect(method).not.toContain("scheduleAutoRetry(")
	})

	it("keeps ordinary automatic compaction retries eligible without changing their frozen cap", async () => {
		const source = await readFile(taskSourcePath, "utf8")
		const providerMethod = extractMethod(source, "async *attemptApiRequest(", "// Block identity is now assigned")
		const recoveryMethod = extractMethod(
			source,
			"private async recoverAutomaticCompactionFailure(",
			"async handleWebviewAskResponse(",
		)

		expect(recoveryMethod).toContain("isSpendLimitError: false")
		expect(recoveryMethod).toContain("this.scheduleAutoRetry(")
		expect(recoveryMethod).toContain('type: "API_RETRY_SCHEDULED", apiIndex')
		expect(recoveryMethod).not.toContain("prepareOpenAiMaxOutputReplay(")
		expect(providerMethod).toContain("this.compactionRequestReplay.getProviderInput(apiIndex)")
	})

	it("flushes the finalized assistant tool turn before executing its tools", async () => {
		const source = await readFile(taskSourcePath, "utf8")
		const method = extractMethod(source, "async recursivelyMakeClineRequests(", "async loadContext(")
		const finalizedTurn = method.indexOf("await this.executeFinalizedAssistantTurn({")
		const assistantAppend = method.lastIndexOf("await this.messageStateHandler.addToApiConversationHistory({", finalizedTurn)
		const assistantRole = method.indexOf('role: "assistant"', assistantAppend)
		const historyFlush = method.indexOf("await this.messageStateHandler.flushApiConversationHistory()", assistantRole)

		expect(assistantAppend).toBeGreaterThanOrEqual(0)
		expect(assistantRole).toBeGreaterThan(assistantAppend)
		expect(historyFlush).toBeGreaterThan(assistantRole)
		expect(finalizedTurn).toBeGreaterThan(historyFlush)
	})

	it("rejects invalid compaction output before the ordinary continuation path", async () => {
		const source = await readFile(taskSourcePath, "utf8")
		const method = extractMethod(source, "async recursivelyMakeClineRequests(", "async loadContext(")
		const finalizedTurn = method.indexOf("await this.executeFinalizedAssistantTurn({")
		const invalidOutput = method.indexOf(
			"this.taskState.isInternalContextCompactionRequest || this.taskState.isManualContextCompactionRequest",
			finalizedTurn,
		)
		const automaticCleanup = method.indexOf("await this.discardFailedCompactionAttempt(apiIndex)", invalidOutput)
		const automaticRecovery = method.indexOf(
			"await this.recoverAutomaticCompactionFailure(apiIndex, errorMessage, requestScope, userContent)",
			automaticCleanup,
		)
		const manualCleanup = method.indexOf("await this.discardFailedManualCompactionAttempt(apiIndex)", automaticRecovery)
		const ordinaryContinuation = method.indexOf("const phaseAfterAssistantTurn", manualCleanup)

		expect(finalizedTurn).toBeGreaterThanOrEqual(0)
		expect(invalidOutput).toBeGreaterThan(finalizedTurn)
		expect(automaticCleanup).toBeGreaterThan(invalidOutput)
		expect(automaticRecovery).toBeGreaterThan(automaticCleanup)
		expect(manualCleanup).toBeGreaterThan(automaticRecovery)
		expect(ordinaryContinuation).toBeGreaterThan(manualCleanup)
	})

	it("tail-truncates failed automatic compaction output before restoring the pre-attempt mistake counter", async () => {
		const source = await readFile(taskSourcePath, "utf8")
		const method = extractMethod(source, "private async discardFailedCompactionAttempt(", "private parsePreviousTokens(")
		const baselineRead = method.indexOf("getInitialConsecutiveMistakeCount(apiIndex)")
		const historyRollback = method.indexOf("truncateApiConversationHistory(historyIndex + 1)", baselineRead)
		const counterRestore = method.indexOf(
			"this.taskState.consecutiveMistakeCount = initialConsecutiveMistakeCount",
			historyRollback,
		)

		expect(baselineRead).toBeGreaterThanOrEqual(0)
		expect(historyRollback).toBeGreaterThan(baselineRead)
		expect(method).not.toContain("overwriteApiConversationHistory(")
		expect(counterRestore).toBeGreaterThan(historyRollback)
	})

	it("updates the same compaction row from the existing retry owner", async () => {
		const source = await readFile(taskSourcePath, "utf8")
		const method = extractMethod(source, "async recursivelyMakeClineRequests(", "async loadContext(")
		const retryBranchStart = method.indexOf("if (retryDecision.shouldRetry) {")
		const retryBranchEnd = method.indexOf("if (retryDecision.shouldPrompt) {", retryBranchStart)
		const retryBranch = method.slice(retryBranchStart, retryBranchEnd)
		const promptBranchEnd = method.indexOf("// needs to happen after the say", retryBranchEnd)
		const promptBranch = method.slice(retryBranchEnd, promptBranchEnd)

		expect(retryBranch).toContain('updateContextCompactionStatus("retrying"')
		expect(promptBranch).toContain('updateContextCompactionStatus("failed"')
		expect(retryBranch).toContain("this.scheduleAutoRetry(")
	})

	it("ends the failed request chain after scheduling an automatic retry without cancelling the task", async () => {
		const source = await readFile(taskSourcePath, "utf8")
		const method = extractMethod(source, "async recursivelyMakeClineRequests(", "async loadContext(")
		const retryBranchStart = method.indexOf("if (retryDecision.shouldRetry) {")
		const retryBranchEnd = method.indexOf("if (retryDecision.shouldPrompt) {", retryBranchStart)
		const retryBranch = method.slice(retryBranchStart, retryBranchEnd)

		expect(retryBranchStart).toBeGreaterThanOrEqual(0)
		expect(retryBranchEnd).toBeGreaterThan(retryBranchStart)
		expect(retryBranch).toContain("this.scheduleAutoRetry(")
		expect(retryBranch).toContain("return true")
		expect(retryBranch).not.toContain("await this.cancelTask()")
		expect(retryBranch).not.toContain("await this.reinitExistingTaskFromId(")
	})

	it("does not start a second request chain after a manual retry continuation is accepted", async () => {
		const source = await readFile(taskSourcePath, "utf8")
		const method = extractMethod(source, "async recursivelyMakeClineRequests(", "async loadContext(")
		const promptBranchStart = method.indexOf("if (retryDecision.shouldPrompt) {")
		const promptBranchEnd = method.indexOf("// needs to happen after the say", promptBranchStart)
		const promptBranch = method.slice(promptBranchStart, promptBranchEnd)

		expect(promptBranchStart).toBeGreaterThanOrEqual(0)
		expect(promptBranchEnd).toBeGreaterThan(promptBranchStart)
		expect(promptBranch).toContain("await this.recoverApiFailure({")
		expect(promptBranch).toContain("return true")
		expect(promptBranch).not.toContain('return outcome.actionId === "start_new_task"')
	})

	it("marks automatic compaction recovery as an unsaved continuation", async () => {
		const source = await readFile(taskSourcePath, "utf8")
		const recoveryMethod = extractMethod(
			source,
			"private async recoverAutomaticCompactionFailure(",
			"async handleWebviewAskResponse(",
		)
		const promptBranchStart = recoveryMethod.indexOf('await this.updateContextCompactionStatus("failed"')
		const recoveryCallStart = recoveryMethod.indexOf("await this.recoverApiFailure({", promptBranchStart)
		const recoveryCallEnd = recoveryMethod.indexOf("})", recoveryCallStart)
		const recoveryCall = recoveryMethod.slice(recoveryCallStart, recoveryCallEnd)

		expect(promptBranchStart).toBeGreaterThanOrEqual(0)
		expect(recoveryCallStart).toBeGreaterThan(promptBranchStart)
		expect(recoveryCall).toContain("persistedRequest: false")
	})

	it("closes or cancels explicit authority at every terminal request boundary", async () => {
		const source = await readFile(taskSourcePath, "utf8")
		const method = extractMethod(source, "async recursivelyMakeClineRequests(", "async loadContext(")
		const approvalBranch = method.indexOf("if (!requestApproved) {")
		const normalClose = method.lastIndexOf("requestScope.explicitInstructions.close()")
		const errorCancel = method.lastIndexOf("requestScope.explicitInstructions.cancel()")

		expect(approvalBranch).toBeGreaterThanOrEqual(0)
		expect(method.slice(approvalBranch, approvalBranch + 160)).toContain("requestScope.explicitInstructions.cancel()")
		expect(normalClose).toBeGreaterThan(approvalBranch)
		expect(errorCancel).toBeGreaterThan(normalClose)
	})

	it("starts explicit instruction authority at the provider boundary and rolls retry attempts", async () => {
		const source = await readFile(taskSourcePath, "utf8")
		const method = extractMethod(source, "async *attemptApiRequest(", "// Block identity is now assigned")
		const beginAttemptIndex = method.indexOf("requestScope.explicitInstructions.beginProviderAttempt(")
		const consumePortIndex = method.indexOf("requestScope.explicitInstructions.createConsumePort()")
		const sendIndex = method.indexOf("api.createMessage(")

		expect(beginAttemptIndex).toBeGreaterThanOrEqual(0)
		expect(consumePortIndex).toBeGreaterThan(beginAttemptIndex)
		expect(sendIndex).toBeGreaterThan(consumePortIndex)
		expect(method).not.toContain("rewriteProviderInstructionIds(")
		expect(method).not.toContain("instruction_id")
		expect(method).toContain("providerAttempt + 1")
	})

	it("routes provider operations in attemptApiRequest through the frozen scope", async () => {
		const source = await readFile(taskSourcePath, "utf8")
		const method = extractMethod(source, "async *attemptApiRequest(", "// Block identity is now assigned")

		expect(method).toContain("const { api, providerInfo } = requestScope")
		expect(method).toContain("api.createMessage(")
		expect(method).toContain("api.parseError?.(")
		expect(method).not.toMatch(/\bthis\.api\b/)
		expect(method).not.toContain("this.getCurrentProviderInfo()")
	})

	it("updates ordinary context selection before applying the shared compaction projection", async () => {
		const source = await readFile(taskSourcePath, "utf8")
		const builder = extractMethod(source, "private async buildProviderInput(", "/** Build the exact ordinary candidate")
		const passBuilder = extractMethod(
			source,
			"private async buildContextCompactionPassRequest(",
			"/** Rebuild the complete target candidate",
		)
		const targetProjection = extractMethod(
			source,
			"private async reprojectContextCompactionTarget(",
			"/** Publish one Session Pass lifecycle",
		)

		const contextManagementIndex = builder.indexOf("this.contextManager.getNewContextMessagesAndMetadata(")
		const projectionIndex = builder.indexOf("this.projectCanonicalContext(apiConversationHistory)")
		expect(contextManagementIndex).toBeGreaterThanOrEqual(0)
		expect(projectionIndex).toBeGreaterThan(contextManagementIndex)
		expect(passBuilder).toContain("applyCompactionProjection: false")
		expect(targetProjection).toContain("applyCompactionProjection: false")
	})

	it("passes frozen hosted tools and the request-scoped compaction cap without a control-tool branch", async () => {
		const source = await readFile(taskSourcePath, "utf8")
		const builder = extractMethod(source, "private async buildProviderInput(", "/** Build the exact ordinary candidate")
		const request = extractMethod(source, "async *attemptApiRequest(", "// Block identity is now assigned")

		expect(builder).toContain("const runtime = resolveFrozenPromptRuntime(frozenPrompt, promptContext)")
		expect(builder).toContain("const serverTools = Object.freeze([")
		expect(builder).toContain("...runtime.webSearchRoutingPlan.serverTools")
		expect(builder).toContain("...requestScope.hostedImageGenerationPlan.serverTools")
		expect(builder).toContain("return { systemPrompt, messages, tools, serverTools, runtime, providerOutputCap: undefined }")
		expect(request).toContain("api.createMessage(systemPrompt, apiConversationMessages, tools, {")
		expect(request).toContain("serverTools,")
		expect(request).toContain('{ generation: { purpose: "compaction", maxOutputTokens: providerOutputCap } as const }')
		expect(request).not.toContain("requestToolIds")
	})

	it("uses live parallel-tool settings for prompt projection and the selected runtime for response execution", async () => {
		const source = await readFile(taskSourcePath, "utf8")
		const promptMethod = extractMethod(source, "private async buildPromptContext(", "private async buildProviderInput(")
		const parallelMethod = extractMethod(
			source,
			"private resolveParallelToolCallingEnabled(",
			"private async switchToActModeCallback(",
		)
		const requestMethod = extractMethod(source, "async *attemptApiRequest(", "// Block identity is now assigned")

		expect(promptMethod).toContain("enableParallelToolCalling: this.resolveParallelToolCallingEnabled(providerInfo)")
		expect(parallelMethod).toContain(
			"return this.activeProviderInputRuntime?.parallelToolsEnabled ?? this.resolveParallelToolCallingEnabled(providerInfo)",
		)
		expect(requestMethod).toContain("this.activeProviderInputRuntime = runtime")
	})

	it("uses the request-frozen Web Tools switch for the prompt and ToolExecutor", async () => {
		const source = await readFile(taskSourcePath, "utf8")
		const promptMethod = extractMethod(source, "private async buildPromptContext(", "private async buildProviderInput(")
		const builderMethod = extractMethod(source, "private async buildProviderInput(", "/** Build the exact ordinary candidate")
		const requestMethod = extractMethod(source, "async *attemptApiRequest(", "// Block identity is now assigned")

		expect(promptMethod).toContain("clineWebToolsEnabled: webToolsEnabled")
		expect(promptMethod).not.toContain('getGlobalSettingsKey("clineWebToolsEnabled")')
		expect(builderMethod).toMatch(
			/this\.buildPromptContext\(\s*providerInfo,\s*requestScope\.webToolsEnabled,\s*requestScope\.webSearchRoutingPlan,?\s*\)/,
		)
		expect(requestMethod).toContain("this.toolExecutor.setPromptRuntime(runtime)")
		expect(requestMethod).toContain(
			"this.toolExecutor.setWebSearchRoutingPlan(requestScope.webSearchRoutingPlan, requestScope.webToolsEnabled)",
		)
		expect(requestMethod.indexOf("this.toolExecutor.setPromptRuntime(runtime)")).toBeLessThan(
			requestMethod.indexOf("this.toolExecutor.setWebSearchRoutingPlan(requestScope.webSearchRoutingPlan"),
		)
		expect(requestMethod).not.toContain("requestToolIds")
	})

	it("uses replay-frozen hosted routing for request approval before falling back to the live request scope", async () => {
		const source = await readFile(taskSourcePath, "utf8")
		const method = extractMethod(source, "private async completeApiRequestGate(", "private isTrustedUserFeedbackResult(")

		const ordinaryReplayIndex = method.indexOf("this.ordinaryRequestInputReplay.get(apiIndex)?.runtime?.webSearchRoutingPlan")
		const compactionReplayIndex = method.indexOf(
			"this.compactionRequestReplay.getProviderInput(apiIndex)?.runtime?.webSearchRoutingPlan",
		)
		const requestScopeIndex = method.indexOf("requestScope.webSearchRoutingPlan")
		expect(ordinaryReplayIndex).toBeGreaterThanOrEqual(0)
		expect(compactionReplayIndex).toBeGreaterThan(ordinaryReplayIndex)
		expect(requestScopeIndex).toBeGreaterThan(compactionReplayIndex)
		expect(method).toContain("routingPlan,")
	})

	it("uses the dedicated browser capability before the legacy image fallback", async () => {
		const source = await readFile(taskSourcePath, "utf8")
		const method = extractMethod(source, "private async buildPromptContext(", "async *attemptApiRequest(")

		expect(method).toContain("capabilities?.supportsBrowserAction ??")
		expect(method).toContain("capabilities?.supportsImages ??")
		expect(method.indexOf("supportsBrowserAction")).toBeLessThan(method.indexOf("supportsImages"))
	})

	it("classifies user cancellation before reporting either API request failure boundary", async () => {
		const source = await readFile(taskSourcePath, "utf8")
		const firstChunkBoundary = extractMethod(source, "async *attemptApiRequest(", "// Block identity is now assigned")
		const iteratorStart = firstChunkBoundary.indexOf("const iterator = stream[Symbol.asyncIterator]()")
		const firstChunkCatchStart = firstChunkBoundary.indexOf("} catch (error) {", iteratorStart)
		const firstChunkCatch = firstChunkBoundary.slice(
			firstChunkCatchStart,
			firstChunkBoundary.indexOf("const isContextWindowExceededError", firstChunkCatchStart),
		)
		const streamingBoundary = extractMethod(source, "async recursivelyMakeClineRequests(", "async loadContext(")
		const streamingStop = streamingBoundary.indexOf("await streamCoordinator?.stop()")
		const streamingCatchStart = streamingBoundary.lastIndexOf("} catch (error) {", streamingStop)
		const streamingCatch = streamingBoundary.slice(
			streamingCatchStart,
			streamingBoundary.indexOf("if (!this.taskState.abandoned)", streamingCatchStart),
		)

		expect(iteratorStart).toBeGreaterThanOrEqual(0)
		expect(firstChunkCatchStart).toBeGreaterThan(iteratorStart)
		expect(firstChunkCatch).toContain("if (this.taskState.abort)")
		expect(firstChunkCatch.indexOf("if (this.taskState.abort)")).toBeLessThan(
			firstChunkBoundary.indexOf("ErrorService.get()", firstChunkCatchStart),
		)
		expect(streamingCatchStart).toBeGreaterThanOrEqual(0)
		expect(streamingCatch).toContain("if (this.taskState.abort)")
	})
})
