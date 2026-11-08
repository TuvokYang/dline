import { ShellEnvironmentProfile, type UpdateShellEnvironmentProfileRequest } from "@shared/proto/dline/file"
import type { UiLanguage } from "@shared/UiLanguage"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { UiLanguageProvider } from "@/i18n/UiLanguageProvider"

const mocks = vi.hoisted(() => ({
    getProfile: vi.fn(),
    listConda: vi.fn(),
    updateProfile: vi.fn(),
}))

vi.mock("@/context/ExtensionStateContext", () => ({
    useExtensionState: () => ({
        availableTerminalProfiles: [{ id: "powershell-7", name: "PowerShell 7" }],
        defaultTerminalProfile: "powershell-7",
        platform: "win32",
        primaryRootIndex: 0,
        workspaceRoots: [{ name: "Workspace [raw]", path: "C:\\work\\raw" }],
    }),
}))

vi.mock("@/services/grpc-client", () => ({
    FileServiceClient: {
        getShellEnvironmentProfile: mocks.getProfile,
        listCondaEnvironments: mocks.listConda,
        updateShellEnvironmentProfile: mocks.updateProfile,
    },
}))

import ShellEnvironmentModal from "./ShellEnvironmentModal"

function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (reason: unknown) => void
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise
        reject = rejectPromise
    })
    return { promise, resolve, reject }
}

function tree(language: UiLanguage) {
    return (
        <UiLanguageProvider language={language}>
            <ShellEnvironmentModal isActive />
        </UiLanguageProvider>
    )
}

async function renderPanel() {
    const view = render(tree("en"))
    await act(async () => {
        await Promise.resolve()
    })
    return view
}

async function advance(milliseconds: number) {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(milliseconds)
    })
}

let persistedProfile: ShellEnvironmentProfile

beforeEach(() => {
    vi.useFakeTimers()
    mocks.getProfile.mockReset()
    mocks.listConda.mockReset()
    mocks.updateProfile.mockReset()
    persistedProfile = ShellEnvironmentProfile.create({
        configPath: "C:\\work\\raw\\.agents\\bashrc.yml",
        environment: [{ name: "RAW_NAME", value: "raw value" }],
        exists: true,
        postCommand: "Write-Output post",
        preCommands: ["Write-Output pre", "Write-Output pre"],
        profile: "powershell-7",
        sourceContent: "version: 1\n",
        startupScripts: ["C:\\existing.ps1", "C:\\existing.ps1"],
        workspacePath: "C:\\work\\raw",
    })
    mocks.getProfile.mockImplementation(async () => persistedProfile)
    mocks.listConda.mockResolvedValue({ values: [] })
    mocks.updateProfile.mockImplementation(async (request: UpdateShellEnvironmentProfileRequest) => {
        persistedProfile = ShellEnvironmentProfile.create({
            ...persistedProfile,
            environment: request.environment,
            postCommand: request.postCommand,
            preCommands: request.preCommands,
            profile: request.profile,
            startupScripts: request.startupScripts,
            workspacePath: request.workspacePath,
            sourceContent: "version: 1\n# saved\n",
        })
        return persistedProfile
    })
})

afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.useRealTimers()
})

describe("ShellEnvironmentModal language changes", () => {
    it.each([
        { tab: "Environment", english: "Environment name 1", chinese: "环境变量名称 1" },
        { tab: "Environment", english: "Environment value 1", chinese: "环境变量值 1" },
        { tab: "Startup Scripts", english: "Startup script 1", chinese: "启动脚本 1" },
        { tab: "Commands", english: "Pre command 1", chinese: "前置命令 1" },
        { tab: "Commands", english: "Post command 1", chinese: "后置命令 1" },
        { tab: "Commands", english: "venv path", chinese: "venv 路径" },
    ])("preserves the $english DOM, focus, selection and draft en → zh → en", async ({ tab, english, chinese }) => {
        const setInterval = vi.spyOn(window, "setInterval")
        const clearInterval = vi.spyOn(window, "clearInterval")
        const view = await renderPanel()
        fireEvent.click(screen.getByRole("tab", { name: tab }))
        if (english === "venv path") {
            fireEvent.change(screen.getByRole("combobox", { name: "Python Env Manager" }), { target: { value: "venv" } })
        }
        const input = screen.getByRole<HTMLInputElement>("textbox", { name: english })
        const draft = "raw draft ${workspaceFolder} / 中文"
        fireEvent.change(input, { target: { value: draft } })
        input.focus()
        input.setSelectionRange(2, 8, "backward")
        const timers = vi.getTimerCount()

        for (const [language, name] of [
            ["zh-CN", chinese],
            ["en", english],
        ] as const) {
            view.rerender(tree(language))
            expect(screen.getByRole("textbox", { name })).toBe(input)
            expect(input).toHaveFocus()
            expect(input).toHaveValue(draft)
            expect([input.selectionStart, input.selectionEnd, input.selectionDirection]).toEqual([2, 8, "backward"])
            expect(screen.getByRole("option", { name: "Workspace [raw]" })).toHaveValue("C:\\work\\raw")
            expect(screen.getByRole("option", { name: "PowerShell 7" })).toHaveValue("powershell-7")
            expect(mocks.getProfile).toHaveBeenCalledTimes(1)
            expect(mocks.listConda).not.toHaveBeenCalled()
            expect(mocks.updateProfile).not.toHaveBeenCalled()
            expect(vi.getTimerCount()).toBe(timers)
            expect(setInterval).toHaveBeenCalledTimes(1)
            expect(clearInterval).not.toHaveBeenCalled()
        }
        if (english === "Startup script 1") {
            expect(screen.getByRole("textbox", { name: "Startup script 2" })).toHaveValue("C:\\existing.ps1")
        }
        if (english === "Pre command 1") {
            expect(screen.getByRole("textbox", { name: "Pre command 2" })).toHaveValue("Write-Output pre")
        }
    })

    it("keeps the save debounce and translates pending and completed status without another save", async () => {
        const pending = deferred<ShellEnvironmentProfile>()
        mocks.updateProfile.mockReturnValueOnce(pending.promise)
        const view = await renderPanel()
        fireEvent.change(screen.getByRole("textbox", { name: "Environment value 1" }), { target: { value: "changed" } })
        await advance(200)
        view.rerender(tree("zh-CN"))
        await advance(149)
        expect(mocks.updateProfile).not.toHaveBeenCalled()
        view.rerender(tree("en"))
        await advance(1)
        expect(mocks.updateProfile).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
                confirmed: true,
                environment: [{ name: "RAW_NAME", value: "changed" }],
                expectedSourceContent: "version: 1\n",
                profile: "powershell-7",
                workspacePath: "C:\\work\\raw",
            }),
        )
        const status = screen.getByRole("status")
        expect(status).toHaveTextContent("Saving...")
        view.rerender(tree("zh-CN"))
        expect(screen.getByRole("status")).toBe(status)
        expect(status).toHaveTextContent("正在保存…")
        view.rerender(tree("en"))
        expect(status).toHaveTextContent("Saving...")
        view.rerender(tree("zh-CN"))

        await act(async () => {
            pending.resolve(
                ShellEnvironmentProfile.create({
                    ...persistedProfile,
                    environment: [{ name: "RAW_NAME", value: "changed" }],
                    sourceContent: "version: 1\n# saved\n",
                }),
            )
        })
        expect(screen.getByRole("status")).toBe(status)
        expect(status).toHaveTextContent("已保存")
        view.rerender(tree("en"))
        expect(status).toHaveTextContent("Saved")
        view.rerender(tree("zh-CN"))
        expect(status).toHaveTextContent("已保存")
        view.rerender(tree("en"))
        await advance(350)
        expect(status).toHaveTextContent("Saved")
        expect(mocks.updateProfile).toHaveBeenCalledTimes(1)
        expect(mocks.getProfile).toHaveBeenCalledTimes(1)
    })

    it("keeps the poll cadence and translates a sync that finishes after switching", async () => {
        const pending = deferred<ShellEnvironmentProfile>()
        const setInterval = vi.spyOn(window, "setInterval")
        const clearInterval = vi.spyOn(window, "clearInterval")
        mocks.getProfile.mockResolvedValueOnce(persistedProfile).mockReturnValueOnce(pending.promise)
        const view = await renderPanel()
        await advance(900)
        view.rerender(tree("zh-CN"))
        await advance(100)
        expect(mocks.getProfile).toHaveBeenCalledTimes(2)
        view.rerender(tree("en"))
        view.rerender(tree("zh-CN"))
        persistedProfile = ShellEnvironmentProfile.create({
            ...persistedProfile,
            preCommands: ["Write-Output external"],
            sourceContent: "version: 1\n# external\n",
        })
        await act(async () => {
            pending.resolve(persistedProfile)
        })
        const status = screen.getByRole("status")
        expect(status).toHaveTextContent("已同步")
        view.rerender(tree("en"))
        expect(screen.getByRole("status")).toBe(status)
        expect(status).toHaveTextContent("Synced")
        view.rerender(tree("zh-CN"))
        expect(status).toHaveTextContent("已同步")
        view.rerender(tree("en"))
        fireEvent.click(screen.getByRole("tab", { name: "Commands" }))
        expect(screen.getByRole("textbox", { name: "Pre command 1" })).toHaveValue("Write-Output external")
        await advance(1000)
        expect(mocks.getProfile).toHaveBeenCalledTimes(3)
        expect(mocks.updateProfile).not.toHaveBeenCalled()
        expect(setInterval).toHaveBeenCalledTimes(1)
        expect(clearInterval).not.toHaveBeenCalled()
    })

    it.each(["settled", "pending"] as const)("translates a %s Conda empty notice without refetching", async (phase) => {
        const pending = deferred<{ values: string[] }>()
        mocks.listConda.mockReturnValueOnce(pending.promise)
        const view = await renderPanel()
        fireEvent.click(screen.getByRole("tab", { name: "Commands" }))
        fireEvent.change(screen.getByRole("combobox", { name: "Python Env Manager" }), { target: { value: "conda" } })
        expect(screen.getByRole("combobox", { name: "Conda environment" })).toBeDisabled()
        if (phase === "settled") {
            await act(async () => pending.resolve({ values: [] }))
            expect(screen.getByText("No Conda environments found")).toBeVisible()
        }
        view.rerender(tree("zh-CN"))
        if (phase === "pending") {
            expect(screen.getByRole("combobox", { name: "Conda 环境" })).toBeDisabled()
            await act(async () => pending.resolve({ values: [] }))
        }
        const notice = screen.getByText("未找到 Conda 环境")
        expect(screen.getByRole("combobox", { name: "Conda 环境" })).toBeEnabled()
        view.rerender(tree("en"))
        expect(screen.getByText("No Conda environments found")).toBe(notice)
        view.rerender(tree("zh-CN"))
        expect(screen.getByText("未找到 Conda 环境")).toBe(notice)
        view.rerender(tree("en"))
        expect(mocks.listConda).toHaveBeenCalledTimes(1)
        expect(mocks.getProfile).toHaveBeenCalledTimes(1)
        expect(mocks.updateProfile).not.toHaveBeenCalled()
    })

    it.each([
        "load",
        "save",
        "conda",
    ] as const)("preserves the real %s Error.message across pending and settled switches", async (operation) => {
        const pending = deferred<never>()
        const message = "Saved / No Conda environments found — C:\\raw\\诊断.ps1 ${value}"
        if (operation === "load") mocks.getProfile.mockReturnValueOnce(pending.promise)
        if (operation === "save") mocks.updateProfile.mockReturnValueOnce(pending.promise)
        if (operation === "conda") mocks.listConda.mockReturnValueOnce(pending.promise)
        const view = await renderPanel()
        if (operation === "save") {
            fireEvent.change(screen.getByRole("textbox", { name: "Environment value 1" }), { target: { value: "changed" } })
            await advance(350)
        }
        if (operation === "conda") {
            fireEvent.click(screen.getByRole("tab", { name: "Commands" }))
            fireEvent.change(screen.getByRole("combobox", { name: "Python Env Manager" }), { target: { value: "conda" } })
        }
        view.rerender(tree("zh-CN"))
        await act(async () => pending.reject(new Error(message)))
        const diagnostic = operation === "conda" ? screen.getByText(message) : screen.getByRole("alert")
        expect(diagnostic.textContent).toBe(message)
        for (const language of ["en", "zh-CN", "en"] as const) {
            view.rerender(tree(language))
            expect(screen.getByText(message)).toBe(diagnostic)
            expect(diagnostic.textContent).toBe(message)
        }
        await advance(350)
        expect(mocks.getProfile).toHaveBeenCalledTimes(1)
        expect(mocks.updateProfile).toHaveBeenCalledTimes(operation === "save" ? 1 : 0)
        expect(mocks.listConda).toHaveBeenCalledTimes(operation === "conda" ? 1 : 0)
    })
})
