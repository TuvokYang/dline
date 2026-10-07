import { beforeEach, describe, expect, it, vi } from "vitest"
import type { TerminalLaunchConfiguration } from "@/integrations/terminal/types"
import type { VscodeTerminalPoolPreparation } from "./VscodeTerminalPool"
import { DefaultVscodeTerminalPoolRuntime } from "./VscodeTerminalPoolRuntime"
import type { TerminalInfo } from "./VscodeTerminalRegistry"

function preparation(): VscodeTerminalPoolPreparation {
	return {
		cwd: "C:\\workspace",
		workspaceRoot: "C:\\workspace",
		profileId: "powershell-legacy",
		shellPath: "powershell",
		environmentFingerprint: "default",
		createLaunchConfiguration: () => ({}),
	}
}

function readyShellIntegration() {
	return {
		executeCommand: vi.fn(() => ({
			async *read() {
				yield ""
			},
		})),
	}
}

/**
 * Model a VS Code terminal. A background terminal gains shell integration after its
 * process starts; a deferred one only activates once it is revealed.
 */
function terminalInfo(activation: "background" | "deferred-until-shown"): TerminalInfo {
	let shellIntegration: ReturnType<typeof readyShellIntegration> | undefined
	if (activation === "background") setTimeout(() => (shellIntegration = readyShellIntegration()), 10)
	const terminal = {
		processId: Promise.resolve(1),
		show: vi.fn(() => {
			shellIntegration = readyShellIntegration()
		}),
		hide: vi.fn(),
		get shellIntegration() {
			return shellIntegration
		},
	} as unknown as TerminalInfo["terminal"]
	return {
		terminal,
		busy: false,
		lastCommand: "",
		id: 1,
		lastActive: Date.now(),
	}
}

describe("DefaultVscodeTerminalPoolRuntime", () => {
	beforeEach(() => vi.restoreAllMocks())

	it("prepares a terminal that activates in the background without touching the panel", async () => {
		const runtime = new DefaultVscodeTerminalPoolRuntime(100, 60_000, 1_000)
		const terminal = terminalInfo("background")

		await runtime.prepareTerminal(terminal, preparation(), {} as TerminalLaunchConfiguration)

		expect(terminal.terminal.shellIntegration?.executeCommand).toBeDefined()
		expect(terminal.terminal.show).not.toHaveBeenCalled()
		// Hiding the panel moves VS Code keyboard focus to the editor group.
		expect(terminal.terminal.hide).not.toHaveBeenCalled()
	})

	it("reveals a deferred terminal with preserved focus and never hides the panel", async () => {
		const runtime = new DefaultVscodeTerminalPoolRuntime(100, 60_000, 20)
		const terminal = terminalInfo("deferred-until-shown")

		await runtime.prepareTerminal(terminal, preparation(), {} as TerminalLaunchConfiguration)

		expect(terminal.terminal.show).toHaveBeenCalledOnce()
		expect(terminal.terminal.show).toHaveBeenCalledWith(true)
		expect(terminal.terminal.hide).not.toHaveBeenCalled()
	})

	it("keeps the background warm budget above the foreground shell wait setting", async () => {
		// The foreground wait is shorter than the reveal grace, so only the warm budget
		// can keep a deferred terminal alive long enough to be revealed.
		const runtime = new DefaultVscodeTerminalPoolRuntime(100, 60_000, 200)
		runtime.setShellIntegrationTimeout(50)
		const terminal = terminalInfo("deferred-until-shown")

		await runtime.prepareTerminal(terminal, preparation(), {} as TerminalLaunchConfiguration)

		expect(terminal.terminal.show).toHaveBeenCalledWith(true)
	})
})
