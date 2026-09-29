import { EventEmitter } from "node:events"
import { StandaloneTerminalManager } from "@integrations/terminal/standalone/StandaloneTerminalManager"
import type { TerminalProcessResultPromise } from "@integrations/terminal/types"
import { describe, expect, it, vi } from "vitest"
import type { SubagentExecResult } from "../../tools/subagent/SubagentExecutor"
import { SubagentJobManager } from "../../tools/subagent/SubagentJobManager"
import { TaskBackgroundResultsOwner } from "../TaskBackgroundResultsOwner"

const completedResult: SubagentExecResult = {
	status: "completed",
	result: "done",
	stats: {
		toolCalls: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheWriteTokens: 0,
		cacheReadTokens: 0,
		totalCost: 0,
		currency: "",
		contextTokens: 0,
		contextWindow: 0,
		contextUsagePercentage: 0,
	},
}

async function createHarness() {
	const manager = new SubagentJobManager()
	const job = manager.startJob({
		task: "review",
		prompt: "review",
		timeoutSeconds: 30,
		runner: async () => completedResult,
	})
	await vi.waitFor(() => expect(manager.getJob(job.jobId)?.status).toBe("completed"))
	const commands = {
		listBackgroundCommands: () => [],
		markBackgroundCommandsInjected: vi.fn(),
		markBackgroundCommandsConsumed: vi.fn(),
	}
	const owner = new TaskBackgroundResultsOwner({
		subagents: { getSubagentJobManager: () => manager },
		commands,
	})
	return { manager, owner, job }
}

describe("TaskBackgroundResultsOwner", () => {
	it("keeps uncommitted results available for the next compose attempt", async () => {
		const { manager, owner, job } = await createHarness()
		const signal = new AbortController().signal

		const first = await owner.collect({ signal })
		const retry = await owner.collect({ signal })

		expect(first?.text).toContain(job.jobId)
		expect(retry?.text).toBe(first?.text)
		expect(manager.getJob(job.jobId)?.injectionState).toBe("pending")
	})

	it("consumes a committed result once using the real manager state machine", async () => {
		const { manager, owner, job } = await createHarness()
		const signal = new AbortController().signal
		const lease = await owner.collect({ signal })

		lease?.commit()
		lease?.commit()

		expect(manager.getJob(job.jobId)?.injectionState).toBe("consumed")
		expect(await owner.collect({ signal })).toBeUndefined()
	})

	it("commits a completed batch and its items together through the real manager", async () => {
		const manager = new SubagentJobManager()
		const batch = manager.startBatch({
			timeoutSeconds: 30,
			items: ["first", "second"].map((task) => ({ task, prompt: task, runner: async () => completedResult })),
		})
		await vi.waitFor(() => expect(manager.getBatch(batch.batchJobId)?.status).toBe("completed"))
		const owner = new TaskBackgroundResultsOwner({
			subagents: { getSubagentJobManager: () => manager },
			commands: {
				listBackgroundCommands: () => [],
				markBackgroundCommandsInjected: vi.fn(),
				markBackgroundCommandsConsumed: vi.fn(),
			},
		})
		const signal = new AbortController().signal
		const lease = await owner.collect({ signal })
		expect(lease?.text).toContain(batch.batchJobId)
		expect(manager.getBatch(batch.batchJobId)?.injectionState).toBe("pending")
		for (const jobId of batch.itemJobIds) {
			expect(lease?.text).toContain(jobId)
			expect(manager.getJob(jobId)?.injectionState).toBe("pending")
		}

		lease?.commit()

		expect(manager.getBatch(batch.batchJobId)?.injectionState).toBe("consumed")
		for (const jobId of batch.itemJobIds) expect(manager.getJob(jobId)?.injectionState).toBe("consumed")
		expect(await owner.collect({ signal })).toBeUndefined()
	})

	it("commits background commands through their real pending/injected/consumed transitions", async () => {
		const manager = new StandaloneTerminalManager()
		const process = Object.assign(new EventEmitter(), { terminate: vi.fn() }) as unknown as TerminalProcessResultPromise
		const command = manager.trackBackgroundCommand(process, "echo done", "background-lease-command")
		process.emit("completed", { exitCode: 0, signal: null })
		const owner = new TaskBackgroundResultsOwner({
			subagents: { getSubagentJobManager: () => new SubagentJobManager() },
			commands: {
				listBackgroundCommands: () => manager.getAllBackgroundCommands(),
				markBackgroundCommandsInjected: (ids) => manager.markBackgroundCommandsInjected(ids),
				markBackgroundCommandsConsumed: (ids) => manager.markBackgroundCommandsConsumed(ids),
			},
		})
		try {
			const signal = new AbortController().signal
			const lease = await owner.collect({ signal })
			expect(lease?.text).toContain(command.id)
			expect(command.injectionState).toBe("pending")

			lease?.commit()

			expect(command.injectionState).toBe("consumed")
			expect(await owner.collect({ signal })).toBeUndefined()
		} finally {
			await manager.disposeBackgroundCommands()
		}
	})
})
