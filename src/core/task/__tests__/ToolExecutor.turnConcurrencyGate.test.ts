import { ToolExecutor } from "@core/task/ToolExecutor"
import { describe, expect, it } from "vitest"

describe("ToolExecutor legacy turn approval authority", () => {
	it("is no longer exposed after concurrency admission moved to TurnToolScheduler", () => {
		const legacyAuthorityNames = Object.getOwnPropertyNames(ToolExecutor.prototype).filter((name) =>
			/turn.*auto.*approved/i.test(name),
		)

		expect(legacyAuthorityNames).toEqual([])
	})
})
