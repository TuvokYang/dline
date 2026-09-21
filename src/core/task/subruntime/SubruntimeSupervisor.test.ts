import { describe, expect, it } from "vitest"
import { ResourceBroker } from "../resources"
import { deferred } from "../runtime/deferred"
import { SubruntimeSupervisor } from "./SubruntimeSupervisor"

describe("SubruntimeSupervisor", () => {
	it("cancels and releases one subruntime without affecting another", async () => {
		const released: string[] = []
		const broker = new ResourceBroker({
			acquire: async (scope, kind) => ({
				value: `${scope.subruntimeId}:${kind}`,
				release: () => {
					released.push(`${scope.subruntimeId}:${kind}`)
				},
			}),
		})
		const gates = new Map<string, ReturnType<typeof deferred<{ resultRef: string }>>>()
		const supervisor = new SubruntimeSupervisor("task-1", broker, {
			run: ({ subruntimeId, signal }) => {
				const gate = deferred<{ resultRef: string }>()
				gates.set(subruntimeId, gate)
				signal.addEventListener("abort", () => gate.reject(new Error("aborted")), { once: true })
				return gate.promise
			},
		})
		const left = await supervisor.start({ subruntimeId: "left", inputRef: "input:left", resourceKinds: ["provider"] })
		const right = await supervisor.start({ subruntimeId: "right", inputRef: "input:right", resourceKinds: ["provider"] })
		expect(left.cancel()).toBe(true)
		await expect(left.completion).rejects.toThrow("aborted")
		expect(supervisor.activeCount).toBe(1)
		gates.get("right")?.resolve({ resultRef: "result:right" })
		await expect(right.completion).resolves.toEqual({ resultRef: "result:right" })
		expect(released.sort()).toEqual(["left:provider", "right:provider"])
	})
})
