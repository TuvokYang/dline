import type { UiLanguage } from "@shared/UiLanguage"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, useState } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const worktreeState = vi.hoisted(() => ({
    listWorktrees: vi.fn(),
    includeExists: true,
    deleteWorktree: vi.fn(),
    mergeWorktree: vi.fn(),
    switchWorktree: vi.fn(),
    getWorktreeDefaults: vi.fn(),
    createWorktree: vi.fn(),
    newTask: vi.fn(),
}))

vi.mock("@vscode/webview-ui-toolkit/react", async (importOriginal) => {
    const { forwardRef } = await import("react")
    return {
        ...(await importOriginal<typeof import("@vscode/webview-ui-toolkit/react")>()),
        VSCodeButton: forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { appearance?: string }>(
            ({ appearance: _appearance, ...props }, ref) => <button type="button" {...props} ref={ref} />,
        ),
        VSCodeTextField: ({ children, ...props }: InputHTMLAttributes<HTMLInputElement>) => (
            <div>
                <input {...props} />
                {children}
            </div>
        ),
        VSCodeCheckbox: (props: InputHTMLAttributes<HTMLInputElement>) => <input {...props} type="checkbox" />,
    }
})

vi.mock("@/context/ExtensionStateContext", () => ({
    useExtensionState: () => ({ environment: "production" }),
}))
vi.mock("@/services/grpc-client", () => ({
    WorktreeServiceClient: {
        listWorktrees: worktreeState.listWorktrees,
        getWorktreeIncludeStatus: vi.fn(async () => ({
            exists: worktreeState.includeExists,
            hasGitignore: false,
            gitignoreContent: "",
        })),
        deleteWorktree: worktreeState.deleteWorktree,
        mergeWorktree: worktreeState.mergeWorktree,
        switchWorktree: worktreeState.switchWorktree,
        getWorktreeDefaults: worktreeState.getWorktreeDefaults,
        createWorktree: worktreeState.createWorktree,
        createWorktreeInclude: vi.fn(),
        trackWorktreeViewOpened: vi.fn(),
    },
    FileServiceClient: { openFileRelativePath: vi.fn() },
    TaskServiceClient: { newTask: worktreeState.newTask },
}))

import CreateWorktreeModal from "@/components/worktrees/CreateWorktreeModal"
import DeleteWorktreeModal from "@/components/worktrees/DeleteWorktreeModal"
import WorktreesView from "@/components/worktrees/WorktreesView"
import { UiLanguageProvider } from "@/i18n/UiLanguageProvider"

const worktree = {
    path: "C:\\work\\feature-x",
    branch: "feature/x",
    isCurrent: false,
    isBare: false,
    isLocked: false,
    isDetached: false,
}

function Switcher({ children }: { children: ReactNode }) {
    const [language, setLanguage] = useState<UiLanguage>("en")
    return (
        <UiLanguageProvider language={language}>
            <button onClick={() => setLanguage(language === "en" ? "zh-CN" : "en")} type="button">
                switch-language
            </button>
            {children}
        </UiLanguageProvider>
    )
}

function switchLanguage() {
    fireEvent.click(screen.getByRole("button", { name: "switch-language" }))
}

describe("worktrees language switching", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        worktreeState.includeExists = true
        worktreeState.getWorktreeDefaults.mockResolvedValue({ suggestedBranch: "feature/x", suggestedPath: "../x" })
        worktreeState.createWorktree.mockResolvedValue({ success: true })
        worktreeState.newTask.mockResolvedValue({})
        worktreeState.listWorktrees.mockResolvedValue({
            worktrees: [worktree],
            isGitRepo: true,
            isMultiRoot: false,
            isSubfolder: false,
            gitRootPath: "C:\\work",
        })
    })

    it("translates the header, description and row actions while keeping the path and branch", async () => {
        render(
            <Switcher>
                <WorktreesView onDone={vi.fn()} />
            </Switcher>,
        )

        expect(await screen.findByRole("heading", { name: "Worktrees" })).toBeTruthy()
        expect(screen.getByText("feature/x")).toBeTruthy()
        expect(screen.getByText("C:\\work\\feature-x")).toBeTruthy()
        const done = screen.getByRole("button", { name: "Done" })
        const openNew = screen.getByRole("button", { name: "Open in new window" })

        await act(async () => switchLanguage())

        expect(screen.getByRole("heading", { name: "工作树" })).toBeTruthy()
        expect(screen.getByRole("button", { name: "完成" })).toBe(done)
        expect(screen.getByRole("button", { name: "新建工作树" })).toBeTruthy()
        expect(screen.getByRole("button", { name: "在新窗口打开" })).toBe(openNew)
        fireEvent.click(openNew)
        expect(worktreeState.switchWorktree).toHaveBeenCalledWith({ path: worktree.path, newWindow: true })
        // Branch names and filesystem paths are data, not display copy.
        expect(screen.getByText("feature/x")).toBeTruthy()
        expect(screen.getByText("C:\\work\\feature-x")).toBeTruthy()

        await act(async () => switchLanguage())
        expect(screen.getByRole("button", { name: "Done" })).toBe(done)
        expect(screen.getByRole("button", { name: "Open in new window" })).toBe(openNew)
    })

    it("renders the complete include tip with persistent emphasis, code and help link slots", async () => {
        worktreeState.includeExists = false
        render(
            <Switcher>
                <WorktreesView onDone={vi.fn()} />
            </Switcher>,
        )

        const file = await screen.findByText(".worktreeinclude", { selector: "code" })
        const example = screen.getByText("node_modules/", { selector: "code" })
        const label = screen.getByText("Tip:", { selector: "strong" })
        const sentence = file.closest("p")!
        const link = sentence.querySelector("a")!
        expect(sentence).toHaveTextContent(
            "Tip: Create a .worktreeinclude file to automatically copy files like node_modules/ to new worktrees, so you don't have to reinstall dependencies.",
        )
        expect(link).toHaveAttribute("href", "https://docs.dline.cc/features/worktrees/#worktreeinclude")

        await act(async () => switchLanguage())
        expect(sentence).toHaveTextContent(
            "提示：创建 .worktreeinclude 文件即可自动把 node_modules/ 这类文件复制到新的工作树，无需重新安装依赖。",
        )
        expect(screen.getByText("提示：", { selector: "strong" })).toBe(label)
        expect(screen.getByText(".worktreeinclude", { selector: "code" })).toBe(file)
        expect(screen.getByText("node_modules/", { selector: "code" })).toBe(example)
        expect(sentence.querySelector("a")).toBe(link)
        expect(link).toHaveAccessibleName("了解更多")
        expect(sentence.textContent).not.toMatch(/\{(?:label|includeFile|exampleDirectory)\}/)

        await act(async () => switchLanguage())
        expect(screen.getByText("Tip:", { selector: "strong" })).toBe(label)
        expect(screen.getByText(".worktreeinclude", { selector: "code" })).toBe(file)
        expect(link).toHaveAccessibleName("Learn more")
    })

    it("translates the unsupported-workspace and error states with their retry action", async () => {
        worktreeState.listWorktrees.mockResolvedValue({
            worktrees: [],
            isGitRepo: true,
            isMultiRoot: true,
            isSubfolder: false,
            gitRootPath: "",
        })
        render(
            <Switcher>
                <WorktreesView onDone={vi.fn()} />
            </Switcher>,
        )

        expect(await screen.findByText("Multi-folder workspace detected")).toBeTruthy()
        await act(async () => switchLanguage())
        expect(screen.getByText("检测到多文件夹工作区")).toBeTruthy()
        expect(screen.getByText(/同一工作区打开多个文件夹时不支持工作树/)).toBeTruthy()
    })

    it("keeps a raw service diagnostic and only translates the product fallback", async () => {
        worktreeState.listWorktrees.mockRejectedValue(new Error("git createWorktree failed: exit 128"))
        render(
            <Switcher>
                <WorktreesView onDone={vi.fn()} />
            </Switcher>,
        )

        expect(await screen.findByText("git createWorktree failed: exit 128")).toBeTruthy()
        await act(async () => switchLanguage())
        // The raw diagnostic is not a translation unit, so it reads the same.
        expect(screen.getByText("git createWorktree failed: exit 128")).toBeTruthy()
        expect(screen.getByRole("button", { name: "重试" })).toBeTruthy()
    })

    it("keeps both create drafts, selections and controls through a round-trip language switch", async () => {
        const onClose = vi.fn()
        render(
            <Switcher>
                <CreateWorktreeModal onClose={onClose} open />
            </Switcher>,
        )

        const branch = screen.getByLabelText<HTMLInputElement>("Branch Name *")
        const path = screen.getByLabelText<HTMLInputElement>("Folder Path *")
        await waitFor(() => expect(branch).toHaveValue("feature/x"))
        fireEvent.input(branch, { target: { value: "feature/user-draft" } })
        fireEvent.input(path, { target: { value: "../user-draft" } })
        branch.focus()
        branch.setSelectionRange(8, 12)
        const submit = screen.getByRole("button", { name: "Create Worktree" })

        await act(async () => switchLanguage())
        expect(screen.getByRole("heading", { name: "创建新工作树" })).toBeTruthy()
        expect(screen.getByLabelText("分支名称 *")).toBe(branch)
        expect(screen.getByLabelText("文件夹路径 *")).toBe(path)
        expect(screen.getByRole("button", { name: "创建工作树" })).toBe(submit)
        expect(branch).toHaveValue("feature/user-draft")
        expect(path).toHaveValue("../user-draft")
        expect([branch.selectionStart, branch.selectionEnd]).toEqual([8, 12])
        expect(screen.getByRole("button", { name: "关闭" })).toBeTruthy()
        expect(screen.getByPlaceholderText("feature/my-feature")).toBe(branch)

        await act(async () => switchLanguage())
        expect(screen.getByLabelText("Branch Name *")).toBe(branch)
        expect(screen.getByLabelText("Folder Path *")).toBe(path)
        expect(screen.getByPlaceholderText("../my-feature-worktree")).toBe(path)
        expect([branch.selectionStart, branch.selectionEnd]).toEqual([8, 12])
        expect(worktreeState.getWorktreeDefaults).toHaveBeenCalledTimes(1)
        await act(async () => fireEvent.click(submit))
        expect(worktreeState.createWorktree).toHaveBeenCalledExactlyOnceWith({
            path: "../user-draft",
            branch: "feature/user-draft",
            createNewBranch: true,
        })
        expect(onClose).toHaveBeenCalledTimes(1)
    })

    it("translates pending creation without replacing the disabled submit control", async () => {
        let finishCreate!: (result: { success: boolean }) => void
        worktreeState.createWorktree.mockReturnValue(
            new Promise((resolve) => {
                finishCreate = resolve
            }),
        )
        const onClose = vi.fn()
        render(
            <Switcher>
                <CreateWorktreeModal onClose={onClose} open openAfterCreate />
            </Switcher>,
        )
        const submit = await screen.findByRole("button", { name: "Create & Open" })
        fireEvent.click(submit)
        expect(submit).toBeDisabled()
        expect(submit).toHaveAccessibleName("Creating & Opening...")

        await act(async () => switchLanguage())
        expect(screen.getByRole("button", { name: "正在创建并打开…" })).toBe(submit)
        expect(submit).toBeDisabled()
        await act(async () => switchLanguage())
        expect(screen.getByRole("button", { name: "Creating & Opening..." })).toBe(submit)
        expect(worktreeState.createWorktree).toHaveBeenCalledTimes(1)
        await act(async () => finishCreate({ success: true }))
        expect(onClose).toHaveBeenCalledTimes(1)
    })

    it("keeps the delete path, branch and checkbox state while translating complete sentences", async () => {
        const onConfirm = vi.fn().mockResolvedValue(undefined)
        const onClose = vi.fn()
        const pathValue = "C:\\work\\{branch}<b>literal</b>"
        const branchValue = "feature/{path}"
        render(
            <Switcher>
                <DeleteWorktreeModal
                    branchName={branchValue}
                    onClose={onClose}
                    onConfirm={onConfirm}
                    open
                    worktreePath={pathValue}
                />
            </Switcher>,
        )

        const path = screen.getByText(pathValue)
        const branch = screen.getByText(branchValue)
        const checkbox = screen.getByRole("checkbox", { name: `Also delete branch ${branchValue}` })
        expect(path.parentElement).toHaveTextContent(`This will delete the worktree directory at ${pathValue}.`)
        expect(path.querySelector("b")).toBeNull()
        fireEvent.click(checkbox)
        expect(checkbox).toBeChecked()

        await act(async () => switchLanguage())
        expect(screen.getByRole("heading", { name: "删除工作树" })).toBeTruthy()
        expect(screen.getByText(pathValue)).toBe(path)
        expect(screen.getByText(branchValue)).toBe(branch)
        expect(path.parentElement).toHaveTextContent(`这将删除工作树目录 ${pathValue}。`)
        expect(screen.getByRole("checkbox", { name: `同时删除分支 ${branchValue}` })).toBe(checkbox)
        expect(checkbox).toBeChecked()
        expect(screen.getByText("警告：该分支上未推送的提交将会丢失。")).toBeTruthy()

        await act(async () => switchLanguage())
        expect(screen.getByRole("checkbox", { name: `Also delete branch ${branchValue}` })).toBe(checkbox)
        expect(checkbox).toBeChecked()
        expect(screen.getByText(pathValue)).toBe(path)
        await act(async () => fireEvent.click(screen.getByRole("button", { name: "Delete" })))
        expect(onConfirm).toHaveBeenCalledExactlyOnceWith(true)
        expect(onClose).toHaveBeenCalledTimes(1)
    })

    it.each([
        "en",
        "zh-CN",
    ] as const)("keeps merge controls and the raw conflict prompt unchanged when submitted in %s", async (language) => {
        worktreeState.listWorktrees.mockResolvedValue({
            worktrees: [{ ...worktree, path: "C:\\work\\main", branch: "main", isCurrent: true }, worktree],
            isGitRepo: true,
            isMultiRoot: false,
            isSubfolder: false,
            gitRootPath: "C:\\work",
        })
        worktreeState.mergeWorktree.mockResolvedValue({
            success: false,
            hasConflicts: true,
            sourceBranch: "feature/x",
            targetBranch: "main",
            conflictingFiles: ["src/a.ts", "src/b.ts", "src/c.ts", "src/raw-{path}.ts"],
        })
        const onDone = vi.fn()
        render(
            <Switcher>
                <WorktreesView onDone={onDone} />
            </Switcher>,
        )
        fireEvent.click(await screen.findByRole("button", { name: "Merge into main" }))
        const source = screen.getByText("feature/x", { selector: "code" })
        const target = screen.getByText("main", { selector: "code" })
        const description = source.closest("p")!
        const checkbox = screen.getByRole("checkbox", { name: "Delete worktree after successful merge" })
        const merge = screen.getByRole("button", { name: "Merge" })
        expect(description).toHaveTextContent("This will merge branch feature/x into main.")
        fireEvent.click(checkbox)

        await act(async () => switchLanguage())
        expect(screen.getByText("feature/x", { selector: "code" })).toBe(source)
        expect(screen.getByText("main", { selector: "code" })).toBe(target)
        expect(description).toHaveTextContent("这会把分支 feature/x 合并到 main。")
        expect(screen.getByRole("checkbox", { name: "成功合并后删除工作树" })).toBe(checkbox)
        expect(checkbox).not.toBeChecked()
        expect(screen.getByRole("button", { name: "合并" })).toBe(merge)

        await act(async () => switchLanguage())
        expect(screen.getByText("feature/x", { selector: "code" })).toBe(source)
        expect(screen.getByRole("checkbox", { name: "Delete worktree after successful merge" })).toBe(checkbox)
        expect(checkbox).not.toBeChecked()
        if (language === "zh-CN") await act(async () => switchLanguage())
        await act(async () => fireEvent.click(merge))
        expect(worktreeState.mergeWorktree).toHaveBeenCalledExactlyOnceWith({
            worktreePath: worktree.path,
            targetBranch: "main",
            deleteAfterMerge: false,
        })
        expect(screen.getByText("src/a.ts", { selector: "li" })).toBeTruthy()
        expect(screen.queryByText("src/raw-{path}.ts", { selector: "li" })).toBeNull()
        expect(worktreeState.newTask).not.toHaveBeenCalled()
        const resolveName = language === "en" ? "Ask Dline to Resolve" : "让 Dline 解决冲突"
        await act(async () => fireEvent.click(screen.getByRole("button", { name: resolveName })))
        expect(worktreeState.newTask).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
                text: "I tried to merge branch 'feature/x' into 'main' but there are merge conflicts in the following files: src/a.ts, src/b.ts, src/c.ts, src/raw-{path}.ts\n\nPlease help me resolve these merge conflicts, then complete the merge, and delete the worktree at: C:\\work\\feature-x",
            }),
        )
        expect(onDone).toHaveBeenCalledTimes(1)
        expect(screen.queryByRole("heading", { name: /Merge Worktree|合并工作树/ })).toBeNull()
    })
})
