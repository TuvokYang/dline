import { describe, expect, it, vi } from "vitest"
import type { TaskEvent, TaskSpawnCommand } from "../../kernel"
import { SpawnCoordinator, type SpawnLease } from "./SpawnCoordinator"

function command(): TaskSpawnCommand {
	return {
		commandId: "spawn-command-1",
		originRevision: 1,
		generation: 0,
		type: "task.spawn",
		spawnAttempt: "spawn-1",
		handoffRef: "handoff:1",
	}
}

describe("SpawnCoordinator", () => {
	it("transfers a provisional lease only after the kernel accepts the spawned receipt", async () => {
		const lease: SpawnLease = {
			admit: vi.fn(async () => ({ childTaskId: "child-1" })),
			dispose: vi.fn(async () => undefined),
		}
		const events: TaskEvent[] = []
		const coordinator = new SpawnCoordinator(
			{ prepare: vi.fn(async () => lease) },
			{ submit: async (event) => (events.push(event), { kind: "accepted" as const }) },
		)
		await coordinator.execute(command())
		expect(events).toEqual([expect.objectContaining({ type: "lifecycle.spawned", childTaskId: "child-1" })])
		expect(lease.dispose).not.toHaveBeenCalled()
	})

	it("disposes the lease when the success receipt is rejected", async () => {
		const lease: SpawnLease = {
			admit: vi.fn(async () => ({ childTaskId: "child-1" })),
			dispose: vi.fn(async () => undefined),
		}
		const coordinator = new SpawnCoordinator(
			{ prepare: vi.fn(async () => lease) },
			{ submit: async () => ({ kind: "rejected" as const }) },
		)
		await coordinator.execute(command())
		expect(lease.dispose).toHaveBeenCalledWith("spawn_receipt_rejected")
	})

	it("still reports terminal failure when compensation also fails", async () => {
		const events: TaskEvent[] = []
		const disposeError = new Error("dispose secret")
		disposeError.name = "DisposeError"
		const coordinator = new SpawnCoordinator(
			{
				prepare: async () => ({
					admit: async () => {
						throw new Error("admit failed")
					},
					dispose: async () => {
						throw disposeError
					},
				}),
			},
			{ submit: async (event) => (events.push(event), { kind: "accepted" as const }) },
		)
		await coordinator.execute(command())
		expect(events).toEqual([
			expect.objectContaining({ type: "lifecycle.spawn_failed", message: "spawn execution failed (DisposeError)" }),
		])
	})

	it("compensates a child that arrives after parent halt without publishing success", async () => {
		let release!: (value: { childTaskId: string }) => void
		const lease: SpawnLease = {
			admit: vi.fn((): Promise<{ childTaskId: string }> => new Promise((resolve) => (release = resolve))),
			dispose: vi.fn(async () => undefined),
		}
		const events: TaskEvent[] = []
		const coordinator = new SpawnCoordinator(
			{ prepare: vi.fn(async () => lease) },
			{ submit: async (event) => (events.push(event), { kind: "accepted" as const }) },
		)
		const running = coordinator.execute(command())
		await vi.waitFor(() => expect(lease.admit).toHaveBeenCalledTimes(1))
		const order = { haltId: "halt-1", generation: 0, reason: "cancel" as const }
		coordinator.fence(order)
		await coordinator.stop(order)
		release({ childTaskId: "child-late" })
		await coordinator.drain(order)
		await running
		expect(lease.dispose).toHaveBeenCalledTimes(1)
		expect(events).toEqual([])
	})
})
