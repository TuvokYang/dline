import { strict as assert } from "node:assert"
import { EventEmitter } from "node:events"
import {
	type BackgroundCommand,
	CommandExecutor,
	StandaloneTerminalManager,
	type TerminalProcessResultPromise,
} from "@integrations/terminal"
import { describe, it } from "vitest"
import { ToolExecutor } from "../../ToolExecutor"
import type { SubagentRunStats } from "../../tools/subagent/SubagentExecutor"
import { SubagentJobManager } from "../../tools/subagent/SubagentJobManager"
import { BackgroundContextInjector, buildTaskBackgroundSection } from "../BackgroundContextInjector"

/**
 * Wait for queued background job promises to settle.
 * @returns Promise that resolves after the current async queue drains.
 */
async function flushJobs(): Promise<void> {
	await Promise.resolve()
	await Promise.resolve()
}

/**
 * Create a background command record for injector tests.
 * @param id Command identifier.
 * @param command Command text.
 * @returns Background command record with pending injection state.
 */
function createCommand(id: string, command: string): BackgroundCommand {
	return {
		id,
		command,
		startTime: Date.now(),
		status: "completed",
		origin: "explicit_background",
		cancellationOwner: "explicit",
		logFilePath: `logs/${id}.log`,
		lineCount: 1,
		injectionState: "pending",
		process: {} as TerminalProcessResultPromise,
	}
}

/**
 * Create subagent execution stats for completed job records.
 * @returns Minimal execution stats for tests.
 */
function createStats(): SubagentRunStats {
	return {
		toolCalls: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheWriteTokens: 0,
		cacheReadTokens: 0,
		totalCost: 0,
		currency: "USD",
		contextTokens: 0,
		contextWindow: 0,
		contextUsagePercentage: 0,
	}
}

describe("BackgroundContextInjector", () => {
	it("exposes task-local background providers for environment details", () => {
		const commands: BackgroundCommand[] = [
			{
				id: "command_1",
				functionId: "call_command_1",
				command: "npm test",
				startTime: Date.now(),
				status: "running",
				origin: "explicit_background",
				cancellationOwner: "explicit",
				logFilePath: "logs/command_1.log",
				lineCount: 1,
				process: {} as TerminalProcessResultPromise,
			},
		]
		const commandExecutor = Object.create(CommandExecutor.prototype) as CommandExecutor
		const commandState = commandExecutor as unknown as {
			standaloneManager: { getAllBackgroundCommands: () => BackgroundCommand[] }
		}
		commandState.standaloneManager = { getAllBackgroundCommands: () => commands }
		const subagentJobManager = new SubagentJobManager()
		const toolExecutor = Object.create(ToolExecutor.prototype) as ToolExecutor
		const toolState = toolExecutor as unknown as { subagentJobManager: SubagentJobManager }
		toolState.subagentJobManager = subagentJobManager

		assert.deepEqual(commandExecutor.listBackgroundCommands(), commands)
		assert.equal(toolExecutor.getSubagentJobManager(), subagentJobManager)
	})

	it("builds task background section from task-local providers", async () => {
		const subagentJobManager = new SubagentJobManager()
		const job = subagentJobManager.startJob({
			task: "review state",
			prompt: "<task>review state</task><context>ctx</context>",
			timeoutSeconds: 30,
			runner: async () => ({ status: "completed", result: "state ok", stats: createStats() }),
		})
		await flushJobs()
		const commands: BackgroundCommand[] = [
			{
				id: "command_2",
				functionId: "call_command_2",
				command: "npm run build",
				startTime: Date.now(),
				status: "running",
				origin: "explicit_background",
				cancellationOwner: "explicit",
				logFilePath: "logs/command_2.log",
				lineCount: 3,
				lastApiSentLineCount: 1,
				process: {} as TerminalProcessResultPromise,
			},
		]

		const details = buildTaskBackgroundSection(
			{ getSubagentJobManager: () => subagentJobManager },
			{ listBackgroundCommands: () => commands },
		)

		assert.match(details, new RegExp(`${job.jobId}: completed — review state`))
		assert.match(details, /function_id: call_command_2/)
		assert.match(details, /status: running/)
		assert.match(details, /output change since last API send: \+2 lines/)
		assert.match(details, /command: npm run build/)
		assert.match(details, /log: logs\/command_2\.log/)
	})

	it("builds injectable background results and pending ids", async () => {
		const subagentJobManager = new SubagentJobManager()
		const job = subagentJobManager.startJob({
			task: "review result state",
			prompt: "<task>review result state</task><context>ctx</context>",
			timeoutSeconds: 30,
			runner: async () => ({ status: "completed", result: "subagent ok", stats: createStats() }),
		})
		await flushJobs()
		const logPath = "logs/command_4.log"
		const command = createCommand("command_4", "npm test")
		command.logFilePath = logPath
		command.exitCode = 0

		const injector = new BackgroundContextInjector({
			subagentJobManager,
			commandProvider: { listBackgroundCommands: () => [command] },
		})
		const result = await injector.buildResultSection()

		assert.match(result.text, /# Background Results/)
		assert.match(result.text, new RegExp(`${job.jobId}: completed — review result state`))
		assert.match(result.text, /subagent ok/)
		assert.match(result.text, /command_4: completed - npm test/)
		assert.match(result.text, new RegExp(logPath.replaceAll("\\", "\\\\")))
		assert.match(result.text, /1 output line/)
		assert.doesNotMatch(result.text, /command ok/)
		assert.deepEqual(result.subagentIds, [job.jobId])
		assert.deepEqual(result.commandIds, [command.id])
	})

	it("injects only the recovered subagent result after a retryable failure and consumes it once", async () => {
		const subagentJobManager = new SubagentJobManager()
		let attempt = 0
		const job = subagentJobManager.startJob({
			task: "recover provider request",
			prompt: "<task>recover provider request</task><context>ctx</context>",
			timeoutSeconds: 30,
			runner: async () => {
				attempt += 1
				return attempt === 1
					? {
							status: "failed",
							error: "sensitive provider diagnostic",
							retryable: true,
							stats: createStats(),
						}
					: {
							status: "completed",
							result: "recovered findings",
							stats: createStats(),
						}
			},
		})
		await flushJobs()
		const injector = new BackgroundContextInjector({ subagentJobManager })

		const failedResult = await injector.buildResultSection()
		assert.equal(failedResult.text, "")
		assert.deepEqual(failedResult.subagentIds, [])
		assert.doesNotMatch(failedResult.text, /sensitive provider diagnostic/)

		assert.equal(await subagentJobManager.retryJob(job.jobId), true)
		await flushJobs()
		const recoveredResult = await injector.buildResultSection()
		assert.deepEqual(recoveredResult.subagentIds, [job.jobId])
		assert.match(recoveredResult.text, /recovered findings/)
		assert.doesNotMatch(recoveredResult.text, /sensitive provider diagnostic/)

		subagentJobManager.markInjected(recoveredResult.subagentIds)
		assert.equal((await injector.buildResultSection()).text, "")
		subagentJobManager.markConsumed(recoveredResult.subagentIds)
		assert.equal((await injector.buildResultSection()).text, "")
		assert.equal(subagentJobManager.getJob(job.jobId)?.injectionState, "consumed")
	})

	it("injects only metadata and a log path for small completed background output", async () => {
		const subagentJobManager = new SubagentJobManager()
		const manager = new StandaloneTerminalManager()
		const process = new EventEmitter() as TerminalProcessResultPromise
		const command = manager.trackBackgroundCommand(process, "npm test", "command_small")
		process.emit("line", "small output", "stdout")
		process.emit("completed", { exitCode: 0, signal: null })

		try {
			const injector = new BackgroundContextInjector({
				subagentJobManager,
				commandProvider: {
					listBackgroundCommands: () => manager.getAllBackgroundCommands(),
				},
			})
			const result = await injector.buildResultSection()

			assert.doesNotMatch(result.text, /small output/)
			assert.match(result.text, /command_small\.log/)
			assert.match(result.text, /1 output line/)
			assert.notEqual(command.logFilePath, undefined)
		} finally {
			await manager.disposeBackgroundCommands()
		}
	})

	it("omits consumed task-local background state from environment details", async () => {
		const subagentJobManager = new SubagentJobManager()
		const job = subagentJobManager.startJob({
			task: "review consumed state",
			prompt: "<task>review consumed state</task><context>ctx</context>",
			timeoutSeconds: 30,
			runner: async () => ({ status: "completed", result: "done", stats: createStats() }),
		})
		await flushJobs()
		subagentJobManager.markInjected([job.jobId])
		subagentJobManager.markConsumed([job.jobId])
		const command = createCommand("command_3", "npm run lint")
		const standaloneManager = new StandaloneTerminalManager()
		const standaloneState = standaloneManager as unknown as { backgroundCommands: Map<string, BackgroundCommand> }
		standaloneState.backgroundCommands.set(command.id, command)
		const commandExecutor = Object.create(CommandExecutor.prototype) as CommandExecutor
		const commandState = commandExecutor as unknown as { standaloneManager: StandaloneTerminalManager }
		commandState.standaloneManager = standaloneManager
		commandExecutor.markBackgroundCommandsInjected([command.id])
		commandExecutor.markBackgroundCommandsConsumed([command.id])

		const details = buildTaskBackgroundSection({ getSubagentJobManager: () => subagentJobManager }, commandExecutor)

		assert.doesNotMatch(details, /review consumed state/)
		assert.doesNotMatch(details, /npm run lint/)
	})

	it("formats non-consumed subagent and command statuses for environment details", async () => {
		const subagentJobManager = new SubagentJobManager()
		const job = subagentJobManager.startJob({
			task: "review api",
			prompt: "<task>review api</task><context>ctx</context>",
			timeoutSeconds: 30,
			runner: async () => ({
				status: "completed",
				result: "api ok",
				stats: {
					toolCalls: 1,
					inputTokens: 10,
					outputTokens: 5,
					cacheWriteTokens: 0,
					cacheReadTokens: 0,
					totalCost: 0,
					currency: "USD",
					contextTokens: 100,
					contextWindow: 1000,
					contextUsagePercentage: 10,
				},
			}),
		})
		await flushJobs()
		const commands: BackgroundCommand[] = [
			{
				id: "command_1",
				command: "npm test",
				startTime: Date.now(),
				status: "completed",
				functionId: "call_command_1",
				origin: "explicit_background",
				cancellationOwner: "explicit",
				logFilePath: "logs/command_1.log",
				lineCount: 12,
				injectionState: "pending",
				process: {} as TerminalProcessResultPromise,
			},
		]

		const injector = new BackgroundContextInjector({
			subagentJobManager,
			commandProvider: { listBackgroundCommands: () => commands },
		})
		const details = injector.buildEnvironmentSection()

		assert.match(details, /# Background Subagents/)
		assert.match(details, new RegExp(`${job.jobId}: completed — review api`))
		assert.match(details, /# Background Commands/)
		assert.match(details, /function_id: call_command_1/)
		assert.match(details, /status: completed/)
		assert.match(details, /output change since last API send: \+12 lines/)
		assert.match(details, /command: npm test/)
		assert.match(details, /log: logs\/command_1\.log/)
	})
})
