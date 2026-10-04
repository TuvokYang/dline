import { strict as assert } from "node:assert"
import { type BackgroundCommand, CommandExecutor, type TerminalProcessResultPromise } from "@integrations/terminal"
import { describe, it } from "vitest"
import type { SubagentExecResult } from "../../tools/subagent/SubagentExecutor"
import { SubagentJobManager } from "../../tools/subagent/SubagentJobManager"
import {
	type BackgroundSubagentProvider,
	buildTaskBackgroundEnvironmentSection,
	buildTaskBackgroundSection,
} from "../BackgroundContextInjector"

async function flushJobs(): Promise<void> {
	await Promise.resolve()
	await Promise.resolve()
}

function createCommand(id: string, command: string, status: BackgroundCommand["status"]): BackgroundCommand {
	return {
		id,
		command,
		startTime: Date.now(),
		status,
		origin: "explicit_background",
		cancellationOwner: "explicit",
		logFilePath: `logs/${id}.log`,
		lineCount: 3,
		lastApiSentLineCount: 1,
		process: {} as TerminalProcessResultPromise,
	}
}

function completedResult(result: string): SubagentExecResult {
	return {
		status: "completed",
		result,
		stats: {
			toolCalls: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheWriteTokens: 0,
			cacheReadTokens: 0,
			totalCost: 0,
			currency: "USD",
			contextTokens: 0,
			contextWindow: 1,
			contextUsagePercentage: 0,
		},
	}
}

describe("BackgroundContextInjector", () => {
	it("exposes task-local background providers for environment details", () => {
		const commands = [createCommand("command_1", "npm test", "running")]
		const commandExecutor = Object.create(CommandExecutor.prototype) as CommandExecutor
		const commandState = commandExecutor as unknown as {
			standaloneManager: { getAllBackgroundCommands: () => BackgroundCommand[] }
		}
		commandState.standaloneManager = { getAllBackgroundCommands: () => commands }
		const subagentJobManager = new SubagentJobManager()
		const subagentProvider: BackgroundSubagentProvider = { getSubagentJobManager: () => subagentJobManager }

		assert.deepEqual(commandExecutor.listBackgroundCommands(), commands)
		assert.equal(subagentProvider.getSubagentJobManager(), subagentJobManager)
	})

	it("projects only currently running background work", async () => {
		const subagentJobManager = new SubagentJobManager()
		const runningJob = subagentJobManager.startJob({
			task: "review running state",
			prompt: "<task>review running state</task><context>ctx</context>",
			timeoutSeconds: 30,
			runner: () => new Promise<SubagentExecResult>(() => undefined),
		})
		const completedJob = subagentJobManager.startJob({
			task: "review completed state",
			prompt: "<task>review completed state</task><context>ctx</context>",
			timeoutSeconds: 30,
			runner: async () => completedResult("done"),
		})
		await flushJobs()
		const runningCommand = createCommand("command_running", "npm run build", "running")
		const completedCommand = createCommand("command_completed", "npm test", "completed")

		const details = buildTaskBackgroundSection(
			{ getSubagentJobManager: () => subagentJobManager },
			{ listBackgroundCommands: () => [runningCommand, completedCommand] },
		)

		assert.match(details, new RegExp(`${runningJob.jobId}: running — review running state`))
		assert.doesNotMatch(details, new RegExp(completedJob.jobId))
		assert.match(details, /function_id: unavailable/)
		assert.match(details, /status: running/)
		assert.match(details, /output change since last API send: \+2 lines/)
		assert.match(details, /command: npm run build/)
		assert.doesNotMatch(details, /npm test/)
	})

	it("captures output baselines only for the running commands represented by the environment text", () => {
		const subagentJobManager = new SubagentJobManager()
		const runningCommand = createCommand("command_running", "npm run build", "running")
		const completedCommand = createCommand("command_completed", "npm test", "completed")

		const section = buildTaskBackgroundEnvironmentSection(
			{ getSubagentJobManager: () => subagentJobManager },
			{ listBackgroundCommands: () => [runningCommand, completedCommand] },
		)

		assert.deepEqual(section.commandLineCounts, [{ id: runningCommand.id, lineCount: runningCommand.lineCount }])
		assert.match(section.text, /command: npm run build/)
		assert.doesNotMatch(section.text, /npm test/)
	})
})
