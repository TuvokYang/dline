import assert from "node:assert/strict"
import path from "node:path"
import { describe, it, vi } from "vitest"
import { VscodeWindowsProcessTreeProvider } from "./VscodeWindowsProcessTreeProvider"

describe("VscodeWindowsProcessTreeProvider", () => {
	it("uses the host module resolver when VS Code exposes the package directly", async () => {
		const processList = [{ pid: 10, ppid: 0, name: "Code.exe" }]
		const getProcessList = vi.fn((_pid: number, callback: (value: typeof processList) => void) => callback(processList))
		const loadModule = vi.fn((modulePath: string) => {
			assert.equal(modulePath, "@vscode/windows-process-tree")
			return { getProcessList }
		})
		const provider = new VscodeWindowsProcessTreeProvider("C:\\app", "C:\\Code.exe", loadModule, async () => [])

		assert.deepEqual(await provider.getProcessList(10), processList)
		assert.equal(loadModule.mock.calls.length, 1)
		assert.equal(getProcessList.mock.calls[0]?.[0], 10)
	})

	it("falls back to the VS Code appRoot asar package", async () => {
		const appRoot = path.join("C:\\Code", "resources", "app")
		const expectedPackageRoot = path.join(appRoot, "node_modules.asar", "@vscode", "windows-process-tree")
		const loadModule = vi.fn((modulePath: string) => {
			if (modulePath === expectedPackageRoot) {
				return {
					getProcessList: (_pid: number, callback: (value: unknown[]) => void) =>
						callback([{ pid: 20, ppid: 0, name: "powershell.exe" }]),
				}
			}
			throw new Error("not found")
		})
		const provider = new VscodeWindowsProcessTreeProvider(appRoot, "C:\\Code\\Code.exe", loadModule, async () => [])

		assert.deepEqual(await provider.getProcessList(20), [{ pid: 20, ppid: 0, name: "powershell.exe" }])
		assert.ok(loadModule.mock.calls.some(([modulePath]) => modulePath === expectedPackageRoot))
	})

	it("rejects when the host module cannot find the requested PID", async () => {
		const provider = new VscodeWindowsProcessTreeProvider(
			"C:\\app",
			"C:\\Code.exe",
			() => ({ getProcessList: (_pid: number, callback: (value: undefined) => void) => callback(undefined) }),
			async () => [],
		)

		await assert.rejects(provider.getProcessList(404), /could not find PID 404/)
	})
})
