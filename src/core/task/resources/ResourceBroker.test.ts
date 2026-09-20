import { describe, expect, it, vi } from "vitest"
import { ResourceBroker } from "./ResourceBroker"

describe("ResourceBroker", () => {
	it("isolates scoped leases and releases each resource once", async () => {
		const release = vi.fn(async () => undefined)
		const broker = new ResourceBroker({
			acquire: async (scope, kind) => ({ value: `${scope.subruntimeId}:${kind}`, release }),
		})
		const left = await broker.acquire({ taskId: "task-1", subruntimeId: "left" }, ["provider", "mcp"])
		const right = await broker.acquire({ taskId: "task-1", subruntimeId: "right" }, ["provider"])
		expect(left.get("provider")).toBe("left:provider")
		expect(right.get("provider")).toBe("right:provider")
		await left.release()
		await left.release()
		expect(release).toHaveBeenCalledTimes(2)
		expect(broker.isActive({ taskId: "task-1", subruntimeId: "left" })).toBe(false)
		expect(broker.isActive({ taskId: "task-1", subruntimeId: "right" })).toBe(true)
		await right.release()
	})
})
