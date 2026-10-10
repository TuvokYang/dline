import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as vscode from "vscode"
import { VscodeTerminalManager } from "./VscodeTerminalManager"
import type { VscodeTerminalPool } from "./VscodeTerminalPool"
import { TerminalRegistry } from "./VscodeTerminalRegistry"

function clearTerminalRegistry(): void {
    for (const terminal of TerminalRegistry.getAllTerminals()) {
        terminal.terminal.dispose()
        TerminalRegistry.removeTerminal(terminal.id)
    }
}

describe("VscodeTerminalManager Windows shell selection", () => {
    const originalPlatform = process.platform

    beforeEach(() => {
        Object.defineProperty(process, "platform", { value: "win32" })
        clearTerminalRegistry()
    })

    afterEach(() => {
        clearTerminalRegistry()
        Object.defineProperty(process, "platform", { value: originalPlatform })
    })

    it("does not drain the shared pool when a new manager applies its initial profile", () => {
        const drainAll = vi.fn(() => ({ closedCount: 0, busyTerminals: [] }))
        const pool = {
            configureShellIntegrationTimeout: vi.fn(),
            drainAll,
        } as unknown as VscodeTerminalPool
        const manager = new VscodeTerminalManager(pool)

        manager.configure({
            defaultTerminalProfile: "powershell-legacy",
            shellIntegrationTimeout: 4_000,
            terminalOutputLineLimit: 500,
            terminalReuseEnabled: true,
        })
        expect(drainAll).not.toHaveBeenCalled()

        manager.configure({
            defaultTerminalProfile: "cmd",
            shellIntegrationTimeout: 4_000,
            terminalOutputLineLimit: 500,
            terminalReuseEnabled: true,
        })
        expect(drainAll).toHaveBeenCalledWith("profile_changed")
    })

    it("invalidates a pooled terminal whose shell integration lacks executeCommand", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true })
        const terminalInfo = TerminalRegistry.createTerminal("C:\\workspace", "powershell")
        Object.defineProperty(terminalInfo.terminal, "shellIntegration", {
            configurable: true,
            value: { cwd: vscode.Uri.file("C:\\workspace") },
        })
        const release = vi.fn(async () => undefined)
        const pool = {
            configureShellIntegrationTimeout: vi.fn(),
            acquire: vi.fn(async () => ({
                leaseId: "lease-1",
                partitionKey: "partition-1",
                terminalInfo,
                reusePolicy: "reusable",
                acquiredAt: Date.now(),
            })),
            release,
            registerProcess: vi.fn(),
            unregisterProcess: vi.fn(),
        } as unknown as VscodeTerminalPool
        const manager = new VscodeTerminalManager(pool)
        manager.configure({
            defaultTerminalProfile: "powershell-legacy",
            shellIntegrationTimeout: 4_000,
            terminalOutputLineLimit: 500,
            terminalReuseEnabled: true,
        })
        const acquired = await manager.getOrCreateTerminal("C:\\workspace", {
            workspaceRoot: "C:\\workspace",
            profileId: "powershell-legacy",
            environmentFingerprint: "default",
        })

        const execution = manager.runCommand(acquired, "echo ready")
        await vi.advanceTimersByTimeAsync(3_000)
        await execution

        expect(release).toHaveBeenCalledTimes(1)
        expect(release).toHaveBeenCalledWith(expect.objectContaining({ leaseId: "lease-1" }), {
            healthy: false,
            reason: "no_shell_integration",
        })
        vi.useRealTimers()
    })

    it("does not repeat the shell-integration wait for a cold fallback", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true })
        try {
            const pool = {
                configureShellIntegrationTimeout: vi.fn(),
                acquire: vi.fn(async () => {
                    throw new Error("Terminal warming already pending")
                }),
                registerProcess: vi.fn(),
                unregisterProcess: vi.fn(),
            } as unknown as VscodeTerminalPool
            const manager = new VscodeTerminalManager(pool)
            manager.configure({
                defaultTerminalProfile: "powershell-legacy",
                shellIntegrationTimeout: 4_000,
                terminalOutputLineLimit: 500,
                terminalReuseEnabled: true,
            })
            const terminal = await manager.getOrCreateTerminal("C:\\workspace", {
                workspaceRoot: "C:\\workspace",
                profileId: "powershell-legacy",
                environmentFingerprint: "default",
            })
            Object.defineProperty(terminal.terminal, "shellIntegration", {
                configurable: true,
                value: undefined,
            })
            const sendText = vi.spyOn(terminal.terminal, "sendText")

            const execution = manager.runCommand(terminal, "echo fallback")
            await Promise.resolve()

            expect(sendText).toHaveBeenCalledWith("echo fallback", true)
            await vi.advanceTimersByTimeAsync(3_000)
            await execution
        } finally {
            vi.useRealTimers()
        }
    })

    it("creates the Dline default terminal with Windows PowerShell", async () => {
        const manager = new VscodeTerminalManager()

        const terminal = await manager.getOrCreateTerminal("C:\\workspace")
        const vscodeTerminal = terminal.terminal as unknown as vscode.Terminal

        // The default Windows profile resolves to the "powershell" shell name; VS Code
        // resolves the concrete executable path from the user's registered profiles.
        // A terminal is only reused when its registered shellPath matches the current
        // profile, so the recorded path must stay stable across creation and reuse.
        const recordedShellPath = terminal.shellPath
        expect(recordedShellPath).toBe("powershell")
        const reused = await manager.getOrCreateTerminal("C:\\workspace")
        expect(reused.shellPath).toBe(recordedShellPath)
        expect((vscodeTerminal.creationOptions as vscode.TerminalOptions).shellPath).toBe("powershell")
        manager.disposeAll()
    })

    it("keeps Command Prompt available when it is selected explicitly", async () => {
        const manager = new VscodeTerminalManager()
        manager.configure({
            defaultTerminalProfile: "cmd",
            shellIntegrationTimeout: 4_000,
            terminalOutputLineLimit: 500,
            terminalReuseEnabled: true,
        })

        const terminal = await manager.getOrCreateTerminal("C:\\workspace")

        expect(terminal.shellPath).toBe("C:\\Windows\\System32\\cmd.exe")
        manager.disposeAll()
    })

    it("passes project environment overrides to a configuration-owned terminal", async () => {
        const manager = new VscodeTerminalManager()

        const terminal = await manager.getOrCreateTerminal("C:\\workspace", {
            configurationId: "workspace-environment-v1",
            environment: { DLINE_E2E_ENV: "configured", REMOVE_ME: null },
        })
        const vscodeTerminal = terminal.terminal as unknown as vscode.Terminal
        const creationOptions = vscodeTerminal.creationOptions as vscode.TerminalOptions

        expect(terminal.configurationId).toBe("workspace-environment-v1")
        expect(creationOptions.env).toMatchObject({
            DLINE_ACTIVE: "true",
            DLINE_E2E_ENV: "configured",
            REMOVE_ME: null,
        })
        manager.disposeAll()
    })

    it("runs startup initialization once when a configuration-owned terminal is created", async () => {
        const manager = new VscodeTerminalManager()
        const runCommand = vi
            .spyOn(manager, "runCommand")
            .mockImplementation(() => Promise.resolve() as unknown as ReturnType<VscodeTerminalManager["runCommand"]>)

        const first = await manager.getOrCreateTerminal("C:\\workspace", {
            configurationId: "workspace-startup-v1",
            initializationCommand: "Initialize-DlineTerminal",
        })
        Object.defineProperty(first.terminal, "shellIntegration", {
            configurable: true,
            value: { cwd: vscode.Uri.file("C:\\workspace") },
        })
        const reused = await manager.getOrCreateTerminal("C:\\workspace", {
            configurationId: "workspace-startup-v1",
            initializationCommand: "Initialize-DlineTerminal",
        })

        expect(reused).toBe(first)
        expect(runCommand).toHaveBeenCalledTimes(1)
        expect(runCommand).toHaveBeenCalledWith(first, "Initialize-DlineTerminal")
        expect(first.lastCommand).toBe("")
        manager.disposeAll()
    })
})
