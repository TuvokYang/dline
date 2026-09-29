import type { CommandExecutor } from "@integrations/terminal/CommandExecutor"
import { describe, expect, it, vi } from "vitest"
import { TaskBackgroundResultsOwner } from "../TaskBackgroundResultsOwner"

describe("TaskBackgroundResultsOwner", () => {
	it("marks a result consumed only after the compose journal commits", async () => {
		const markConsumed = vi.fn()
		const manager = {
			listInjectableResults: () => [
				{
					kind: "single" as const,
					job: {
						jobId: "job-1",
						task: "review",
						prompt: "review",
						status: "completed" as const,
						startedAt: 1,
						finishedAt: 2,
						timeoutSeconds: 30,
						result: "done",
						attempt: 1,
						injectionState: "pending" as const,
					},
				},
			],
			markConsumed,
		}
		const commands = {
			listBackgroundCommands: () => [],
			markBackgroundCommandsConsumed: vi.fn(),
		} as unknown as CommandExecutor
		const owner = new TaskBackgroundResultsOwner({
			subagents: { getSubagentJobManager: () => manager as never },
			commands,
		})

		const lease = await owner.collect({ signal: new AbortController().signal })

		expect(lease?.text).toContain("job-1")
		expect(markConsumed).not.toHaveBeenCalled()
		lease?.commit()
		expect(markConsumed).toHaveBeenCalledWith(["job-1"])
		lease?.commit()
		expect(markConsumed).toHaveBeenCalledOnce()
	})
})
