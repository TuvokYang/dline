import { readFile } from "node:fs/promises"
import path from "node:path"
import { describe, expect, it } from "vitest"

const taskSourcePath = path.resolve("src/core/task/index.ts")

function extractMethod(source: string, startMarker: string, endMarker: string): string {
	const start = source.indexOf(startMarker)
	const end = source.indexOf(endMarker, start)
	if (start < 0 || end < 0) throw new Error(`Unable to locate Task metrics boundary: ${startMarker}`)
	return source.slice(start, end)
}

function expectContains(source: string, expected: string): void {
	expect(source.includes(expected), `Expected Task metrics boundary to contain: ${expected}`).toBe(true)
}

/**
 * Asserts a call chain is present without depending on where it wraps.
 *
 * These are source-text assertions, so a formatter moving `.catch()` onto its
 * own line would otherwise read as a missing recovery path.
 */
function expectChain(source: string, ...segments: string[]): void {
	const pattern = new RegExp(segments.map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s*"))
	expect(pattern.test(source), `Expected Task metrics boundary to chain: ${segments.join(" … ")}`).toBe(true)
}

function expectNotContains(source: string, unexpected: string): void {
	expect(source.includes(unexpected), `Expected Task metrics boundary not to contain: ${unexpected}`).toBe(false)
}

describe("Task API rate metrics boundary", () => {
	it("uses Task-local active, round, and execution facts without mixing RPM bases", async () => {
		const source = await readFile(taskSourcePath, "utf8")
		const owner = await readFile(path.resolve("src/core/task/performance/TaskMetricsOwner.ts"), "utf8")
		const composition = extractMethod(source, "this.metrics = new TaskMetricsOwner({", "this.reinitExistingTaskFromId =")
		const headerSnapshot = extractMethod(
			source,
			"public getApiRateSnapshot(): ApiRateSnapshot {",
			"/** Query persisted Task-local API rate history",
		)

		expectContains(source, "private readonly metrics: TaskMetricsOwner")
		expectContains(composition, "legacySource: { getAll: () => this.messageStateHandler.durableClineMessages }")
		expectContains(owner, "new TaskApiRateMetricsRepository({ taskId: options.taskId, readOnly: this.readOnly })")
		expectContains(owner, "const roundRepository = new TaskApiRequestRoundRepository({")
		expectContains(
			owner,
			"const executionRepository = new TaskApiResponseExecutionRepository({ taskId: options.taskId, readOnly: this.readOnly })",
		)
		expectContains(owner, "roundRepository,")
		expectContains(owner, "executionRepository,")
		expectContains(owner, "waitForRoundPersistence: () => this.rounds.waitForRoundPersistence()")
		expectContains(owner, "waitForExecutionPersistence: () => this.rounds.waitForExecutionPersistence()")
		expectContains(source, "return this.metrics.reader.query(query)")
		expectChain(owner, "this.rounds", ".initializeRounds()", ".catch((error) =>")
		expectChain(owner, "this.rounds", ".initializeExecutions()", ".catch((error) =>")
		expectNotContains(source, "new TaskApiRateMetricsRepository(")
		expectNotContains(source, "private readonly apiRateTracker: ApiRateTracker")
		expectContains(headerSnapshot, "return this.metrics.reader.getSnapshot()")
		expectContains(owner, "const active = this.rates.getSnapshot()")
		expectContains(owner, "const rounds = this.rounds.getSnapshot()")
		expectContains(owner, "const executions = this.rounds.getExecutionSnapshot()")
		expectContains(owner, "requestsPerMinute: executions.requestsPerMinute")
		expectContains(owner, "rpmBasis: executions.rpmBasis")
		expectContains(owner, "tokensPerMinute: active.tokensPerMinute")
	})

	/**
	 * A new Task must have metrics ready before it can issue a request, but a
	 * restored one must not: metrics are a secondary projection there, and
	 * awaiting them would hold back the historical surface the user is waiting
	 * to see. The two paths therefore assert opposite things on purpose.
	 */
	it("initializes metrics before a new Task can reach an API request", async () => {
		const source = await readFile(taskSourcePath, "utf8")
		const startTask = extractMethod(source, "public async startTask(", "/**\n\t * Load and display historical task messages")

		expect(startTask.indexOf("await this.ensureApiRateMetricsInitialized()")).toBeGreaterThanOrEqual(0)
		expect(startTask.indexOf("await this.ensureApiRateMetricsInitialized()")).toBeLessThan(
			startTask.indexOf("TASK_INITIALIZE_REQUESTED"),
		)
	})

	it("waits for metrics only after a restored Task's historical surface is published", async () => {
		const source = await readFile(taskSourcePath, "utf8")
		const prepareFromHistory = extractMethod(
			source,
			"public async prepareFromHistory(",
			"private async patchInterruptedCommandCards(",
		)

		expectContains(prepareFromHistory, 'runStage("history_metrics", () => this.ensureApiRateMetricsInitialized(), true)')
		expectContains(prepareFromHistory, "await Promise.all([")
		expectNotContains(prepareFromHistory, "void this.ensureApiRateMetricsInitialized()")
	})

	it("aggregates Provider usage and commits one final exact request snapshot", async () => {
		const source = await readFile(taskSourcePath, "utf8")

		expectContains(source, "onStreamEstimatedTokens: (tokens) => this.apiRateMetricsService.recordEstimatedTokens(tokens)")
		expectContains(source, "this.apiRateMetricsService.setTaskLoopActive(isTaskRateMetricsLoopActive(state.phase))")
		expectContains(source, "this.apiRateMetricsService.trackProviderStream(")
		expectContains(source, "const usageTracker = new TaskRequestUsageTracker()")
		expectContains(source, "const usage = usageTracker.apply(chunk)")
		expectContains(source, "const usage = usageTracker.apply(apiStreamUsage)")
		expectContains(source, "const finalUsage = usageTracker.getSnapshot()")
		expectContains(source, "thoughtsTokens: finalUsage.thoughtsTokens")
		expect(source.match(/this\.apiRateMetricsService\.recordExactUsage\(\{/g)).toHaveLength(1)
		expectNotContains(source, "thoughtsTokens: chunk.thoughtsTokenCount")
		expectNotContains(source, "thoughtsTokens: apiStreamUsage.thoughtsTokenCount")
		expectNotContains(source, "this.apiRateTracker.recordExactTokens(")
	})

	it("keeps metrics close in the required termination barrier", async () => {
		const source = await readFile(taskSourcePath, "utf8")
		const terminate = extractMethod(source, "async terminate(", "/** Close idle task terminals")

		expect(terminate).toContain('withRequiredTerminateTimeout(this.metrics.close(), 5_000, "taskMetrics.close")')
		expect(terminate).toContain("this.messageResources.close()")
		expect(terminate).toContain("if (requiredCloseFailure !== undefined) throw requiredCloseFailure")
		expect(terminate).not.toContain('withTerminateTimeout(this.metrics.close(), 5_000, "taskMetrics.close")')
		expect(terminate).not.toContain("this.apiRateTracker.dispose()")
	})
})
