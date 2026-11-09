import { Empty } from "@shared/proto/dline/common"
import { RefreshedDlineToggles, RuleScope } from "@shared/proto/dline/file"
import { createTaskCapabilityToggles } from "@shared/TaskCapabilityToggles"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { UiLanguageProvider } from "@/i18n/UiLanguageProvider"
import { CapabilityScopeNotice } from "./CapabilityScopeNotice"
import ClineRulesToggleModal from "./ClineRulesToggleModal"
import NewRuleRow from "./NewRuleRow"

const mocks = vi.hoisted(() => ({
    taskScoped: true,
    updateToggle: vi.fn(),
    reconcile: vi.fn(),
    refreshRules: vi.fn(),
    toggleClineRule: vi.fn(),
    createSubagentFile: vi.fn(),
    setGlobal: vi.fn(),
    setLocal: vi.fn(),
    noop: vi.fn(),
}))
const globalPath = "C:\\User Name\\Rules\\Keep English.md"
const localPath = "C:\\workspace\\本地规则.md"
let snapshot = createTaskCapabilityToggles({})
const extensionState = {
    globalClineRulesToggles: { [globalPath]: true },
    localClineRulesToggles: { [localPath]: true },
    localCursorRulesToggles: {},
    localWindsurfRulesToggles: {},
    localAgentsRulesToggles: {},
    localWorkflowToggles: {},
    globalWorkflowToggles: {},
    remoteRulesToggles: {},
    remoteWorkflowToggles: {},
    remoteConfigSettings: { remoteGlobalRules: [], remoteGlobalWorkflows: [] },
    hooksEnabled: true,
    setGlobalClineRulesToggles: mocks.setGlobal,
    setLocalClineRulesToggles: mocks.setLocal,
    setLocalCursorRulesToggles: mocks.noop,
    setLocalWindsurfRulesToggles: mocks.noop,
    setLocalAgentsRulesToggles: mocks.noop,
    setLocalWorkflowToggles: mocks.noop,
    setGlobalWorkflowToggles: mocks.noop,
    setGlobalSkillsToggles: mocks.noop,
    setLocalSkillsToggles: mocks.noop,
    setRemoteSkillsToggles: mocks.noop,
    setRemoteRulesToggles: mocks.noop,
    setRemoteWorkflowToggles: mocks.noop,
}
vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => extensionState }))
vi.mock("@/hooks/useTaskCapabilityToggles", () => ({
    useTaskCapabilityToggles: () => ({
        isTaskScoped: mocks.taskScoped,
        snapshot: mocks.taskScoped ? snapshot : undefined,
        updateToggle: mocks.updateToggle,
        reconcile: mocks.reconcile,
    }),
}))
vi.mock("@/services/grpc-client", () => ({
    FileServiceClient: {
        refreshRules: mocks.refreshRules,
        toggleClineRule: mocks.toggleClineRule,
        createSubagentFile: mocks.createSubagentFile,
    },
}))
// Environment UI has a different owner; this test exercises the real capability popup and rows.
vi.mock("@/components/chat/ShellEnvironmentModal", () => ({ default: () => <div /> }))

beforeEach(() => {
    vi.clearAllMocks()
    mocks.taskScoped = true
    snapshot = createTaskCapabilityToggles({
        globalClineRulesToggles: { [globalPath]: true },
        localClineRulesToggles: { [localPath]: true },
    })
    mocks.reconcile.mockResolvedValue(undefined)
    mocks.updateToggle.mockImplementation(
        async (key: "globalClineRulesToggles" | "localClineRulesToggles", path: string, enabled: boolean) => {
            snapshot = { ...snapshot, [key]: { ...snapshot[key], [path]: enabled } }
        },
    )
    mocks.refreshRules.mockResolvedValue(
        RefreshedDlineToggles.create({
            globalClineRulesToggles: { toggles: { [globalPath]: true } },
            localClineRulesToggles: { toggles: { [localPath]: true } },
        }),
    )
    mocks.toggleClineRule.mockResolvedValue(
        RefreshedDlineToggles.create({ globalClineRulesToggles: { toggles: { [globalPath]: false } } }),
    )
    mocks.createSubagentFile.mockResolvedValue(Empty.create({}))
})
afterEach(cleanup)

describe("capability scope and popup live language", () => {
    it("updates the already-open real tooltip portal in both directions without opening or refreshing the popup", async () => {
        const tree = (language: "en" | "zh-CN") => (
            <UiLanguageProvider language={language}>
                <ClineRulesToggleModal />
            </UiLanguageProvider>
        )
        const view = render(tree("en"))
        const trigger = screen.getByRole("button", { name: "Show Dline Rules & Workflows" })
        fireEvent.focus(trigger)
        const tooltip = await screen.findByRole("tooltip", { name: "Manage Dline Rules & Workflows" })
        expect(view.container).not.toContainElement(tooltip)
        view.rerender(tree("zh-CN"))
        expect(screen.getByRole("tooltip", { name: "管理 Dline 规则与工作流" })).toBe(tooltip)
        expect(screen.getByRole("button", { name: "显示 Dline 规则与工作流" })).toBe(trigger)
        view.rerender(tree("en"))
        expect(screen.getByRole("tooltip", { name: "Manage Dline Rules & Workflows" })).toBe(tooltip)
        expect(screen.queryByTestId("capabilities-popup")).not.toBeInTheDocument()
        expect(mocks.refreshRules).not.toHaveBeenCalled()
    })

    it.each([true, false])("keeps the open popup, draft and exact toggle route (task scope: %s)", async (taskScoped) => {
        mocks.taskScoped = taskScoped
        const tree = (language: "en" | "zh-CN") => (
            <UiLanguageProvider language={language}>
                <ClineRulesToggleModal />
            </UiLanguageProvider>
        )
        const view = render(tree("en"))
        fireEvent.click(screen.getByRole("button", { name: "Show Dline Rules & Workflows" }))
        await waitFor(() => expect(mocks.refreshRules).toHaveBeenCalledTimes(1))
        const popup = screen.getByTestId("capabilities-popup")
        const toggle = screen.getByRole("switch", { name: "Enable Keep English.md" })
        const draft = screen.getAllByPlaceholderText("New rule file...")[0]
        fireEvent.click(draft)
        fireEvent.change(draft, { target: { value: "draft-original.md" } })
        view.rerender(tree("zh-CN"))
        expect(screen.getByTestId("capabilities-popup")).toBe(popup)
        expect(screen.getByRole("button", { name: "隐藏 Dline 规则与工作流" })).toBeInTheDocument()
        expect(screen.getByTestId("capability-scope-notice")).toHaveAttribute("data-scope", taskScoped ? "task" : "workspace")
        expect(screen.getByTestId("capability-scope-notice")).toHaveTextContent(
            taskScoped ? "开关设置仅保存到此任务" : "开关设置保存到此工作区",
        )
        expect(screen.getByDisplayValue("draft-original.md")).toBe(draft)
        expect(screen.getByRole("switch", { name: "启用 Keep English.md" })).toBe(toggle)
        expect(toggle).toHaveAttribute("data-state", "checked")
        fireEvent.click(toggle)
        await waitFor(() => expect(toggle).toHaveAttribute("data-state", "unchecked"))
        if (taskScoped) {
            expect(mocks.updateToggle).toHaveBeenCalledWith("globalClineRulesToggles", globalPath, false)
            expect(mocks.toggleClineRule).not.toHaveBeenCalled()
        } else {
            expect(mocks.toggleClineRule).toHaveBeenCalledWith({ scope: RuleScope.GLOBAL, rulePath: globalPath, enabled: false })
            expect(mocks.updateToggle).not.toHaveBeenCalled()
        }
        view.rerender(tree("en"))
        expect(screen.getByRole("switch", { name: "Enable Keep English.md" })).toBe(toggle)
        expect(toggle).toHaveAttribute("data-state", "unchecked")
        expect(screen.getByDisplayValue("draft-original.md")).toBe(draft)
        expect(screen.getByTestId("capabilities-popup")).toBe(popup)
        expect(mocks.refreshRules).toHaveBeenCalledTimes(1)
        expect(screen.getByText("本地规则.md")).toBeInTheDocument()
    })

    it.each(["global", "workspace", "task"] as const)("translates storage explanation without changing %s identity", (scope) => {
        const tree = (language: "en" | "zh-CN") => (
            <UiLanguageProvider language={language}>
                <CapabilityScopeNotice scope={scope} />
            </UiLanguageProvider>
        )
        const view = render(tree("en"))
        const notice = screen.getByTestId("capability-scope-notice")
        const english = notice.textContent
        view.rerender(tree("zh-CN"))
        expect(screen.getByTestId("capability-scope-notice")).toBe(notice)
        expect(notice).toHaveAttribute("data-scope", scope)
        expect(notice.textContent).not.toBe(english)
        view.rerender(tree("en"))
        expect(notice).toHaveTextContent(english || "")
        expect(notice).toHaveAttribute("data-scope", scope)
    })

    it("keeps validation semantic, preserves a user draft and submits its original subagent identity", async () => {
        const tree = (language: "en" | "zh-CN") => (
            <UiLanguageProvider language={language}>
                <NewRuleRow isGlobal ruleType="subagent" />
            </UiLanguageProvider>
        )
        const view = render(tree("en"))
        const input = screen.getByPlaceholderText("New subagent...")
        fireEvent.click(input)
        fireEvent.change(input, { target: { value: "invalid name" } })
        fireEvent.submit(input.closest("form")!)
        expect(screen.getByRole("alert")).toHaveTextContent("Subagent name can only contain")
        view.rerender(tree("zh-CN"))
        expect(screen.getByRole("alert")).toHaveTextContent("子智能体名称只能包含")
        expect(screen.getByDisplayValue("invalid name")).toBe(input)
        expect(mocks.createSubagentFile).not.toHaveBeenCalled()
        view.rerender(tree("en"))
        expect(screen.getByRole("alert")).toHaveTextContent("Subagent name can only contain")
        fireEvent.change(input, { target: { value: "User-Agent_128" } })
        fireEvent.submit(input.closest("form")!)
        await waitFor(() =>
            expect(mocks.createSubagentFile).toHaveBeenCalledWith({ subagentName: "User-Agent_128", isGlobal: true }),
        )
    })
})
