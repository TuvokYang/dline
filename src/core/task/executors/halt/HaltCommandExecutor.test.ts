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

	it("bounds a stuck participant, keeps its fence, and waits for real quiescence before rearm", async () => {
		const failures: ParticipantId[] = []
		const events: TaskEvent[] = []
		let resolveDrain!: () => void
		const provider: HaltParticipant = {
			id: "provider",
			fence: vi.fn(),
			stop: vi.fn(),
			drain: () => new Promise<void>((resolve) => (resolveDrain = resolve)),
			rearm: vi.fn(),
		}
		const tool: HaltParticipant = {
			id: "tool",
			fence: vi.fn(),
			stop: vi.fn(),
			drain: async () => undefined,
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
				expect.objectContaining({ type: "halt.failed", participantId: "provider" }),
				expect.objectContaining({ type: "halt.halted", participantId: "tool" }),
			]),
		)
		expect(failures).toEqual(["provider"])
		let rearmed = false
		const rearm = executor.rearm("halt-1").then(() => (rearmed = true))
		await Promise.resolve()
		expect(rearmed).toBe(false)
		resolveDrain()
		await rearm
		expect(provider.rearm).toHaveBeenCalledWith("halt-1")
	})
})
