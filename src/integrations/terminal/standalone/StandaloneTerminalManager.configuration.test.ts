import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "vitest"
import { getShellForProfile } from "@/utils/shell"
import { StandaloneTerminal } from "./StandaloneTerminal"
import { StandaloneTerminalManager } from "./StandaloneTerminalManager"

describe("StandaloneTerminalManager configuration", () => {
	const originalPlatform = process.platform

	beforeEach(() => {
		Object.defineProperty(process, "platform", { value: "win32" })
	})

	afterEach(() => {
		Object.defineProperty(process, "platform", { value: originalPlatform })
	})

	it("uses the selected shell and isolates terminal reuse by project environment", async () => {
		const manager = new StandaloneTerminalManager()
		manager.configure({
			defaultTerminalProfile: "cmd",
			shellIntegrationTimeout: 4_000,
			terminalOutputLineLimit: 500,
			terminalReuseEnabled: true,
		})

		const first = await manager.getOrCreateTerminal("C:\\workspace", {
			configurationId: "environment-v1",
			environment: { DLINE_CONFIGURED: "yes" },
		})
		const reused = await manager.getOrCreateTerminal("C:\\workspace", {
			configurationId: "environment-v1",
			environment: { DLINE_CONFIGURED: "yes" },
		})
		const changed = await manager.getOrCreateTerminal("C:\\workspace", {
			configurationId: "environment-v2",
			environment: { DLINE_CONFIGURED: "changed" },
		})

		assert.equal(first, reused)
		assert.notEqual(first.id, changed.id)
		assert.equal(first.shellPath, "C:\\Windows\\System32\\cmd.exe")
		assert.deepEqual((first.terminal as StandaloneTerminal)._environment, { DLINE_CONFIGURED: "yes" })
		// Each acquisition reports where its terminal came from, so the command
		// duration metric can separate a reuse from a full shell start. The
		// reused handle is the same object, so the value has to be rewritten on
		// every acquisition rather than left at its creation-time value.
		assert.equal(reused.acquisitionSource, "registry_reuse")
		assert.equal(changed.acquisitionSource, "cold_start")
		manager.disposeAll()
	})

	it("reports a cold start for the first acquisition of a configuration", async () => {
		const manager = new StandaloneTerminalManager()
		manager.configure({
			defaultTerminalProfile: "cmd",
			shellIntegrationTimeout: 4_000,
			terminalOutputLineLimit: 500,
			terminalReuseEnabled: true,
		})

		const created = await manager.getOrCreateTerminal("C:\\workspace", { configurationId: "environment-v1" })

		assert.equal(created.acquisitionSource, "cold_start")
		manager.disposeAll()
	})

	it("resolves the Windows WSL profile to wsl.exe", () => {
		assert.equal(getShellForProfile("wsl-bash"), "C:\\Windows\\System32\\wsl.exe")
	})
})
