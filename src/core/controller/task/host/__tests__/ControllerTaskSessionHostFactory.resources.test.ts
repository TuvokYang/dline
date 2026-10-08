import { describe, expect, it, vi } from "vitest"

const owners = vi.hoisted(() => ({
	callbackDispose: vi.fn(async () => undefined),
	fileDispose: vi.fn(),
	initializeHistory: vi.fn(),
}))

vi.mock("../ControllerTaskCallbacksOwner", () => ({
	ControllerTaskCallbacksOwner: class {
		dispose = owners.callbackDispose
	},
}))
vi.mock("@core/context/context-tracking/FileContextTracker", () => ({
	FileContextTracker: class {
		dispose = owners.fileDispose
	},
}))
vi.mock("@core/context/context-management/ContextManager", () => ({
	ContextManager: class {
		initializeContextHistory = owners.initializeHistory
	},
}))
vi.mock("@core/storage/disk", async (original) => ({
	...(await original<typeof import("@core/storage/disk")>()),
	ensureTaskDirectoryExists: async () => ".",
}))

import type { TaskSessionHostContext } from "@core/task/composition/TaskSessionHostFactory"
import { HostProvider } from "@/hosts/host-provider"
import { ControllerTaskSessionHostFactory } from "../ControllerTaskSessionHostFactory"

// Before create() returns, the composition root cannot own these host handles.
describe("ControllerTaskSessionHostFactory rollback", () => {
	it("releases partially acquired host owners when context initialization fails", async () => {
		const failure = new Error("context history unavailable")
		owners.initializeHistory.mockRejectedValue(failure)
		vi.spyOn(HostProvider, "get").mockReturnValue({ createDiffViewProvider: () => ({}) } as never)
		const factory = new ControllerTaskSessionHostFactory({
			controller: {} as never,
			context: {} as never,
			stateManager: {} as never,
			mcpHub: {} as never,
			ignoreController: {} as never,
		})
		try {
			await expect(factory.create({ taskId: "failed-host-open" } as TaskSessionHostContext)).rejects.toBe(failure)
			expect(owners.fileDispose).toHaveBeenCalledOnce()
			expect(owners.callbackDispose).toHaveBeenCalledOnce()
		} finally {
			vi.restoreAllMocks()
		}
	})
})
