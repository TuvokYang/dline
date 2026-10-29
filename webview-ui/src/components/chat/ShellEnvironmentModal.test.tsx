// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
    getProfile: vi.fn(),
    listConda: vi.fn(),
    updateProfile: vi.fn(),
}))

const extensionState = {
    availableTerminalProfiles: [
        { id: "default", name: "Default" },
        { id: "powershell-legacy", name: "Windows PowerShell" },
        { id: "powershell-7", name: "PowerShell 7" },
    ],
    defaultTerminalProfile: "default",
    platform: "win32",
    primaryRootIndex: 0,
    workspaceRoots: [
        { name: "One", path: "C:\\work\\one" },
        { name: "Two", path: "C:\\work\\two" },
    ],
}

vi.mock("@/context/ExtensionStateContext", () => ({
    useExtensionState: () => extensionState,
}))

vi.mock("@/services/grpc-client", () => ({
    FileServiceClient: {
        getShellEnvironmentProfile: mocks.getProfile,
        listCondaEnvironments: mocks.listConda,
        updateShellEnvironmentProfile: mocks.updateProfile,
    },
}))

import ShellEnvironmentModal from "./ShellEnvironmentModal"

let persistedPreCommands: string[]
let persistedSourceContent: string

function profile(workspacePath = "C:\\work\\one", selectedProfile = "powershell-legacy") {
    return {
        configPath: `${workspacePath}\\.agents\\bashrc.yml`,
        environment: [{ name: "EXISTING", value: "value" }],
        exists: true,
        postCommand: "Write-Output post",
        preCommands: [...persistedPreCommands],
        profile:
            selectedProfile === "default"
                ? extensionState.platform === "win32"
                    ? "powershell-legacy"
                    : "bash"
                : selectedProfile,
        sourceContent: persistedSourceContent,
        startupScripts: ["C:\\existing.ps1"],
        workspacePath,
    }
}

describe("ShellEnvironmentModal", () => {
    beforeEach(() => {
        extensionState.availableTerminalProfiles = [
            { id: "default", name: "Default" },
            { id: "powershell-legacy", name: "Windows PowerShell" },
            { id: "powershell-7", name: "PowerShell 7" },
        ]
        extensionState.defaultTerminalProfile = "default"
        extensionState.platform = "win32"
        persistedPreCommands = ["Write-Output pre"]
        persistedSourceContent = "version: 1\n"
        mocks.getProfile.mockReset()
        mocks.getProfile.mockImplementation((request: { workspacePath: string; profile: string }) =>
            Promise.resolve(profile(request.workspacePath, request.profile)),
        )
        mocks.listConda.mockReset()
        mocks.listConda.mockResolvedValue({ values: ["base", "dline"] })
        mocks.updateProfile.mockReset()
        mocks.updateProfile.mockImplementation((request: { preCommands: string[]; workspacePath: string; profile: string }) => {
            persistedPreCommands = [...request.preCommands]
            persistedSourceContent = "version: 1\nplatforms: {}\n"
            return Promise.resolve({
                ...profile(request.workspacePath, request.profile),
                exists: true,
            })
        })
    })

    it("keeps Default selected and automatically saves edits without footer actions", async () => {
        const user = userEvent.setup()
        render(<ShellEnvironmentModal isActive />)
        await waitFor(() =>
            expect(mocks.getProfile).toHaveBeenCalledWith(
                expect.objectContaining({ profile: "default", workspacePath: "C:\\work\\one" }),
            ),
        )

        const terminalProfile = screen.getByLabelText("Terminal Profile")
        expect(terminalProfile).toHaveValue("default")
        expect(screen.getByRole("option", { name: "Default" })).toBeInTheDocument()
        expect(screen.queryByRole("button", { name: "Open config" })).not.toBeInTheDocument()
        expect(screen.queryByRole("button", { name: "Reinitialize" })).not.toBeInTheDocument()
        expect(screen.queryByRole("button", { name: "Review changes" })).not.toBeInTheDocument()
        expect(screen.queryByLabelText("Example")).not.toBeInTheDocument()
        expect(screen.queryByText(/bashrc\.yml/)).not.toBeInTheDocument()

        await user.selectOptions(screen.getByLabelText("Workspace"), "C:\\work\\two")
        await user.selectOptions(terminalProfile, "powershell-7")
        await waitFor(() =>
            expect(mocks.getProfile).toHaveBeenCalledWith(
                expect.objectContaining({ profile: "powershell-7", workspacePath: "C:\\work\\two" }),
            ),
        )

        await user.click(screen.getByRole("button", { name: "Add variable" }))
        await user.type(screen.getByLabelText("Environment name 2"), "ADDED")
        await user.type(screen.getByLabelText("Environment value 2"), "configured")
        await waitFor(
            () =>
                expect(mocks.updateProfile).toHaveBeenLastCalledWith(
                    expect.objectContaining({
                        confirmed: true,
                        environment: expect.arrayContaining([expect.objectContaining({ name: "ADDED", value: "configured" })]),
                        profile: "powershell-7",
                        workspacePath: "C:\\work\\two",
                    }),
                ),
            { timeout: 2500 },
        )
        expect(await screen.findByText("Saved")).toBeInTheDocument()
    })

    it("surfaces an automatic save error without adding a confirmation flow", async () => {
        const user = userEvent.setup()
        mocks.updateProfile.mockRejectedValueOnce(new Error("save failed"))
        render(<ShellEnvironmentModal isActive />)
        await waitFor(() => expect(mocks.getProfile).toHaveBeenCalled())

        await user.clear(screen.getByLabelText("Environment value 1"))
        await user.type(screen.getByLabelText("Environment value 1"), "changed")
        expect(await screen.findByRole("alert")).toHaveTextContent("save failed")
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    })

    it("uses matching add and remove controls for pre and post commands", async () => {
        const user = userEvent.setup()
        mocks.getProfile.mockResolvedValueOnce({
            ...profile(),
            postCommand: undefined,
            preCommands: [],
        })
        render(<ShellEnvironmentModal isActive />)
        await waitFor(() => expect(mocks.getProfile).toHaveBeenCalled())

        await user.click(screen.getByRole("tab", { name: "Commands" }))
        await user.click(screen.getByRole("button", { name: "Add pre command" }))
        await user.click(screen.getByRole("button", { name: "Add post command" }))

        expect(screen.getByRole("textbox", { name: "Pre command 1" })).toBeVisible()
        expect(screen.getByRole("textbox", { name: "Post command 1" })).toBeVisible()
        expect(screen.queryByRole("button", { name: "Add post command" })).not.toBeInTheDocument()

        await user.click(screen.getByRole("button", { name: "Remove post command 1" }))
        expect(screen.getByRole("button", { name: "Add post command" })).toBeVisible()
    })

    it("loads Conda environments and automatically saves the selected environment as a preCommand", async () => {
        const user = userEvent.setup()
        render(<ShellEnvironmentModal isActive />)
        await waitFor(() => expect(mocks.getProfile).toHaveBeenCalled())

        await user.click(screen.getByRole("tab", { name: "Commands" }))
        await user.selectOptions(screen.getByLabelText("Python Env Manager"), "conda")
        await waitFor(() => expect(mocks.listConda).toHaveBeenCalledOnce())
        await user.selectOptions(screen.getByLabelText("Conda environment"), "dline")

        expect(screen.getByRole("textbox", { name: "Pre command 1" })).toHaveValue("conda activate dline")
        expect(screen.getByRole("textbox", { name: "Pre command 2" })).toHaveValue("Write-Output pre")
        await waitFor(() =>
            expect(mocks.updateProfile).toHaveBeenLastCalledWith(
                expect.objectContaining({ preCommands: ["conda activate dline", "Write-Output pre"] }),
            ),
        )
    })

    it("uses the extension platform for a Default-profile venv activation", async () => {
        const user = userEvent.setup()
        render(<ShellEnvironmentModal isActive />)
        await waitFor(() => expect(mocks.getProfile).toHaveBeenCalled())

        await user.click(screen.getByRole("tab", { name: "Commands" }))
        await user.selectOptions(screen.getByLabelText("Python Env Manager"), "venv")
        const venvPath = screen.getByLabelText("venv path")
        fireEvent.change(venvPath, { target: { value: "${workspaceFolder}\\.venv" } })

        expect(screen.getByRole("textbox", { name: "Pre command 1" })).toHaveValue(
            '& "${workspaceFolder}\\.venv\\Scripts\\Activate.ps1"',
        )
        await user.selectOptions(screen.getByLabelText("Python Env Manager"), "none")
        expect(screen.getByRole("textbox", { name: "Pre command 1" })).toHaveValue("Write-Output pre")
        expect(screen.queryByRole("textbox", { name: "Pre command 2" })).not.toBeInTheDocument()
    })

    it("generates a POSIX venv activation on Linux even when the Webview test process is not Linux", async () => {
        const user = userEvent.setup()
        extensionState.platform = "linux"
        extensionState.availableTerminalProfiles = [
            { id: "default", name: "Default" },
            { id: "bash", name: "bash" },
        ]
        render(<ShellEnvironmentModal isActive />)
        await waitFor(() => expect(mocks.getProfile).toHaveBeenCalled())

        await user.click(screen.getByRole("tab", { name: "Commands" }))
        await user.selectOptions(screen.getByLabelText("Python Env Manager"), "venv")
        expect(screen.getByRole("textbox", { name: "Pre command 1" })).toHaveValue(
            `. '${"${workspaceFolder}"}/.venv/bin/activate'`,
        )
    })

    it("synchronizes an external bashrc.yml change back into the active editor", async () => {
        render(<ShellEnvironmentModal isActive />)
        await waitFor(() => expect(mocks.getProfile).toHaveBeenCalled())
        fireEvent.click(screen.getByRole("tab", { name: "Commands" }))

        persistedPreCommands = ["conda activate dline"]
        persistedSourceContent = "version: 1\nplatforms:\n  win32: {}\n"

        await waitFor(() => expect(screen.getByLabelText("Python Env Manager")).toHaveValue("conda"), { timeout: 2500 })
        expect(screen.getByLabelText("Conda environment")).toHaveValue("dline")
        expect(screen.getByRole("textbox", { name: "Pre command 1" })).toHaveValue("conda activate dline")
        expect(screen.getByRole("status")).toHaveTextContent("Synced")
    })
})
