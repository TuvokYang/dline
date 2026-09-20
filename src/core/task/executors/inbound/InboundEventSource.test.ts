import { describe, expect, it } from "vitest"
import type { TaskEvent } from "../../kernel"
import { BackgroundIngressExecutor } from "../background"
import { CoTaskIngressExecutor } from "../cotask"

describe("inbound event executors", () => {
	it("publish source events and fence new arrivals until the matching rearm", async () => {
		const events: TaskEvent[] = []
		const sink = { submit: async (event: TaskEvent) => (events.push(event), { kind: "accepted" as const }) }
		const background = new BackgroundIngressExecutor(() => 3, sink)
		const cotask = new CoTaskIngressExecutor(() => 3, sink)

		await background.publish({ entryId: "bg-1", payloadRef: "result:1" })
		await cotask.publish({ entryId: "co-1", payloadRef: "message:1" })
		expect(events).toEqual([
			expect.objectContaining({ type: "background.ready", generation: 3, entryId: "bg-1" }),
			expect.objectContaining({ type: "cotask.received", generation: 3, entryId: "co-1" }),
		])

		const order = { haltId: "halt-1", generation: 3, reason: "cancel" as const }
		background.fence(order)
		expect(await background.publish({ entryId: "bg-2", payloadRef: "result:2" })).toEqual({
			kind: "fenced",
			haltId: "halt-1",
		})
		background.rearm("older")
		expect((await background.publish({ entryId: "bg-3", payloadRef: "result:3" })).kind).toBe("fenced")
		background.rearm("halt-1")
		expect((await background.publish({ entryId: "bg-4", payloadRef: "result:4" })).kind).toBe("accepted")
	})
})
