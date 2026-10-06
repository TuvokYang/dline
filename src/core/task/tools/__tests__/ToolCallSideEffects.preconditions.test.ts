import { describe, expect, it, vi } from "vitest"
import { ClineDefaultTool } from "@/shared/tools"
import { awaitToolCallPreconditions } from "../ToolCallSideEffects"

function pendingBaseline() {
	let release: () => void = () => undefined
	const baseline = new Promise<void>((resolve) => (release = resolve))
	return { awaitInitialCheckpoint: vi.fn(() => baseline), release: () => release() }
}

async function settlesBeforeRelease(promise: Promise<void>): Promise<boolean> {
	let settled = false
	void promise.then(() => (settled = true))
	await new Promise((resolve) => setTimeout(resolve, 0))
	return settled
}

describe("awaitToolCallPreconditions", () => {
	it.each([
		ClineDefaultTool.FILE_NEW,
		ClineDefaultTool.BASH,
		ClineDefaultTool.ATTEMPT,
	])("holds %s until the baseline exists", async (tool) => {
		const port = pendingBaseline()

		const waiting = awaitToolCallPreconditions(port, tool)

		expect(await settlesBeforeRelease(waiting)).toBe(false)
		port.release()
		await expect(waiting).resolves.toBeUndefined()
		expect(port.awaitInitialCheckpoint).toHaveBeenCalledOnce()
	})

	it("lets a read-only tool overlap the baseline", async () => {
		const port = pendingBaseline()

		await expect(awaitToolCallPreconditions(port, ClineDefaultTool.FILE_READ)).resolves.toBeUndefined()

		expect(port.awaitInitialCheckpoint).not.toHaveBeenCalled()
	})

	it("runs the tool when the baseline failed", async () => {
		const port = { awaitInitialCheckpoint: vi.fn(async () => Promise.reject(new Error("shadow repository unavailable"))) }

		await expect(awaitToolCallPreconditions(port, ClineDefaultTool.FILE_NEW)).resolves.toBeUndefined()
	})

	it("does nothing on a surface without workspace history", async () => {
		await expect(awaitToolCallPreconditions({}, ClineDefaultTool.FILE_NEW)).resolves.toBeUndefined()
	})
})
