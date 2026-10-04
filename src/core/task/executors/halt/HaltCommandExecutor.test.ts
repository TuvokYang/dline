import { describe, expect, it, vi } from "vitest"
import type { HaltStopCommand, ParticipantId, TaskEvent } from "../../kernel"
import { ALL_HALT_PARTICIPANTS } from "../../kernel/machines/halt"
import type { HaltParticipant } from "../contracts"
import { HaltCommandExecutor } from "./HaltCommandExecutor"
import { assertCompleteHaltParticipants, CallbackHaltParticipant } from "./participants"

function command(participantIds: readonly ParticipantId[] = ALL_HALT_PARTICIPANTS): HaltStopCommand {
	return {
		commandId: "halt-command-1",
		originRevision: 2,
		generation: 0,
		type: "halt.stop",
		haltId: "halt-1",
		participantIds,
		reason: "cancel",
	}
}

describe("HaltCommandExecutor", () => {
	it("fences every domain before any stop and submits one receipt per participant", async () => {
		const calls: string[] = []
		const participants = ALL_HALT_PARTICIPANTS.map(
			(id) =>
				new CallbackHaltParticipant({
					id,
					fence: () => calls.push(`fence:${id}`),
					stop: () => void calls.push(`stop:${id}`),
					drain: async () => void calls.push(`drain:${id}`),
				}),
		)
		assertCompleteHaltParticipants(participants)
		const events: TaskEvent[] = []
		const executor = new HaltCommandExecutor(participants, {
			submit: async (event) => (events.push(event), { kind: "accepted" as const }),
		})
		await executor.execute(command())

		expect(calls.slice(0, ALL_HALT_PARTICIPANTS.length)).toEqual(ALL_HALT_PARTICIPANTS.map((id) => `fence:${id}`))
		expect(events).toHaveLength(ALL_HALT_PARTICIPANTS.length)
		expect(events.every((event) => event.type === "halt.halted")).toBe(true)
	})

	it("reports a timed-out participant without clearing its pending fence", async () => {
		const failures: ParticipantId[] = []
		const events: TaskEvent[] = []
		let releaseProvider!: () => void
		const providerDrain = new Promise<void>((resolve) => (releaseProvider = resolve))
		const provider: HaltParticipant = {
			id: "provider",
			fence: vi.fn(),
			stop: vi.fn(),
			drain: () => providerDrain,
			rearm: vi.fn(),
		}
		const tool: HaltParticipant = {
			id: "tool",
			fence: vi.fn(),
			stop: vi.fn(),
			drain: async () => undefined,
			rearm: vi.fn(),
		}
		const executor = new HaltCommandExecutor(
			[provider, tool],
			{ submit: async (event) => (events.push(event), { kind: "accepted" as const }) },
			{ timeoutMs: 5, onParticipantFailure: (id) => failures.push(id) },
		)
		await executor.execute(command(["provider", "tool"]))
		expect(provider.fence).toHaveBeenCalledTimes(1)
		expect(events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "lifecycle.halt_timeout", participantId: "provider" }),
				expect.objectContaining({ type: "halt.halted", participantId: "tool" }),
			]),
		)
		expect(events.some((event) => event.type === "halt.failed" && event.participantId === "provider")).toBe(false)

		let rearmed = false
		const rearming = executor.rearm("halt-1").then(() => {
			rearmed = true
		})
		await new Promise((resolve) => setTimeout(resolve, 10))
		expect(rearmed).toBe(false)
		expect(provider.rearm).not.toHaveBeenCalled()

		releaseProvider()
		await rearming
		await vi.waitFor(() =>
			expect(events.some((event) => event.type === "halt.halted" && event.participantId === "provider")).toBe(true),
		)
		expect(tool.rearm).toHaveBeenCalledWith("halt-1")
		expect(provider.rearm).toHaveBeenCalledWith("halt-1")
		expect(failures).toEqual(["provider"])
	})

	it("rearms a participant that drains after its receipt but within the deadline", async () => {
		const events: TaskEvent[] = []
		let releaseDrain!: () => void
		const drained = new Promise<void>((resolve) => (releaseDrain = resolve))
		const provider: HaltParticipant = {
			id: "provider",
			fence: vi.fn(),
			stop: () => void setTimeout(releaseDrain, 0),
			drain: () => drained,
			rearm: vi.fn(),
		}
		const executor = new HaltCommandExecutor(
			[provider],
			{ submit: async (event) => (events.push(event), { kind: "accepted" as const }) },
			{ timeoutMs: 50 },
		)

		await executor.execute(command(["provider"]))
		await executor.rearm("halt-1")

		expect(events).toEqual([expect.objectContaining({ type: "halt.halted", participantId: "provider" })])
		expect(provider.rearm).toHaveBeenCalledWith("halt-1")
	})
})
