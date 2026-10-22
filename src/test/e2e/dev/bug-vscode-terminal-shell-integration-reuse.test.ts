import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame, type Locator, type Page } from "@playwright/test"

interface TerminalEvent {
    readonly index: number
    readonly terminalId: number
}

function terminalCommand(marker: string, exitCode: number): string {
    if (process.platform === "win32") {
        return `Write-Output "${marker}"; & $env:ComSpec /d /c "exit ${exitCode}"`
    }
    return `printf '${marker}\\n'; (exit ${exitCode})`
}

function parseWarmEvents(output: string): TerminalEvent[] {
    return [...output.matchAll(/\[TerminalPool\] operation=warm partition=[a-f0-9]+ terminalId=(\d+) state=ready/g)].map(
        (match) => ({ index: match.index, terminalId: Number(match[1]) }),
    )
}

function parseAcquireEvents(output: string): TerminalEvent[] {
    return [...output.matchAll(/\[TerminalPool\] operation=acquire partition=[a-f0-9]+ terminalId=(\d+) policy=reusable/g)].map(
        (match) => ({ index: match.index, terminalId: Number(match[1]) }),
    )
}

async function openTerminalSettings(page: Page, sidebar: Frame): Promise<void> {
    await page.getByRole("button", { name: "Settings", exact: true }).click()
    await expect(sidebar.getByRole("heading", { name: "API Configuration" })).toBeVisible({ timeout: 30_000 })
    await sidebar.getByTestId("tab-terminal").click()
    await expect(sidebar.getByText("Enable aggressive terminal reuse", { exact: true })).toBeVisible()
}

async function selectOption(sidebar: Frame, dropdown: Locator, value: string, label: string): Promise<void> {
    await dropdown.click()
    await sidebar.getByRole("option", { name: label, exact: true }).click()
    await expect.poll(() => dropdown.evaluate((element) => (element as HTMLSelectElement).value)).toBe(value)
}

async function setProductionShellIntegrationTimeout(sidebar: Frame): Promise<void> {
    const input = sidebar
        .getByText("Shell integration timeout (seconds)", { exact: true })
        .locator("..")
        .locator("vscode-text-field input")
    await input.fill("4")
    await input.blur()
    await expect(input).toHaveValue("4")
}

e2e(
    "VS Code terminal captures the first command and reuses one healthy terminal at the production timeout",
    async ({ helper, page, server, sidebar, userDataDir }) => {
        e2e.setTimeout(300_000)
        await helper.signin(sidebar)
        await openTerminalSettings(page, sidebar)
        await selectOption(sidebar, sidebar.locator("#terminal-execution-mode"), "vscodeTerminal", "VS Code Terminal")
        if (process.platform === "win32") {
            await selectOption(sidebar, sidebar.locator("#default-terminal-profile"), "powershell-legacy", "Windows PowerShell")
        }
        await setProductionShellIntegrationTimeout(sidebar)
        await sidebar.getByRole("button", { name: "Done", exact: true }).click()
        await expect(sidebar.getByTestId("chat-input")).toBeVisible()

        const commands = [
            { id: "first", marker: "E2E_TERMINAL_CAPTURE_FIRST", exitCode: 7 },
            { id: "second", marker: "E2E_TERMINAL_CAPTURE_SECOND", exitCode: 0 },
            { id: "third", marker: "E2E_TERMINAL_CAPTURE_THIRD", exitCode: 0 },
        ].map((entry) => ({ ...entry, command: terminalCommand(entry.marker, entry.exitCode) }))

        server.resetOpenAiMock()
        server.enqueueOpenAiResponses(
            {
                type: "tool",
                id: `call_terminal_${commands[0].id}`,
                name: "execute_command",
                arguments: {
                    command: commands[0].command,
                    workdirectory: ".",
                    requires_approval: true,
                    synchronous: true,
                    timeout: 60,
                },
            },
            {
                type: "tool",
                id: `call_terminal_${commands[1].id}`,
                name: "execute_command",
                arguments: {
                    command: commands[1].command,
                    workdirectory: ".",
                    requires_approval: true,
                    synchronous: true,
                    timeout: 60,
                },
                expectedToolResults: [
                    {
                        callId: `call_terminal_${commands[0].id}`,
                        contentIncludes: [commands[0].marker, "Command failed with exit code 7."],
                    },
                ],
            },
            {
                type: "tool",
                id: `call_terminal_${commands[2].id}`,
                name: "execute_command",
                arguments: {
                    command: commands[2].command,
                    workdirectory: ".",
                    requires_approval: true,
                    synchronous: true,
                    timeout: 60,
                },
                expectedToolResults: [
                    {
                        callId: `call_terminal_${commands[1].id}`,
                        contentIncludes: [commands[1].marker, "Command executed successfully (exit code 0)."],
                    },
                ],
            },
            {
                type: "tool",
                id: "call_terminal_reuse_complete",
                name: "attempt_completion",
                arguments: { result: "E2E_TERMINAL_REUSE_COMPLETE" },
                expectedToolResults: [
                    {
                        callId: `call_terminal_${commands[2].id}`,
                        contentIncludes: [commands[2].marker, "Command executed successfully (exit code 0)."],
                    },
                ],
            },
        )

        const input = sidebar.getByTestId("chat-input")
        await input.fill("Run the three foreground terminal capture and reuse checks.")
        await sidebar.getByTestId("send-button").click()

        for (let commandNumber = 1; commandNumber <= commands.length; commandNumber++) {
            const approve = sidebar.getByText("Approve", { exact: true }).last()
            await expect(approve).toBeVisible({ timeout: 60_000 })
            await approve.click()
            await expect.poll(() => server.openAiRequestCount, { timeout: 90_000 }).toBe(commandNumber + 1)
        }
        await expect(sidebar.getByText("E2E_TERMINAL_REUSE_COMPLETE", { exact: false }).last()).toBeVisible({
            timeout: 60_000,
        })

        const output = await E2ETestHelper.readDlineOutput(userDataDir)
        const acquires = parseAcquireEvents(output).slice(-commands.length)
        expect(acquires).toHaveLength(commands.length)
        expect(new Set(acquires.map((event) => event.terminalId)).size).toBe(1)

        const firstAcquireIndex = acquires[0].index
        const replacementWarmEvents = parseWarmEvents(output).filter((event) => event.index > firstAcquireIndex)
        expect(replacementWarmEvents, "sequential reusable commands must not prewarm and discard replacement terminals").toEqual(
            [],
        )
        expect(output).not.toContain("[TerminalPool] operation=fallback")
        expect(output).not.toContain("[TerminalPerf] phase=capability_failure")
        await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
    },
)
