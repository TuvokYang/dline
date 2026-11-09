import type { UiLanguage } from "@shared/UiLanguage"
import { fireEvent, render, screen } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"
import { AccountWelcomeView } from "@/components/account/AccountWelcomeView"
import WhatsNewItems from "@/components/common/WhatsNewItems"
import WhatsNewModal from "@/components/common/WhatsNewModal"
import { SuggestedTasks } from "@/components/welcome/SuggestedTasks"
import WelcomeView from "@/components/welcome/WelcomeView"
import { DLINE_REPOSITORY_URL } from "@/config/source-links"
import { translateUi, UI_MESSAGES } from "@/i18n/messages"
import { UiLanguageProvider } from "@/i18n/UiLanguageProvider"
import { en } from "./en"
import { zhCN } from "./zh_CN"

vi.mock("@vscode/webview-ui-toolkit/react", async () => {
    const { createElement } = await import("react")
    return {
        VSCodeButton: ({
            appearance: _appearance,
            ...props
        }: import("react").ButtonHTMLAttributes<HTMLButtonElement> & { appearance?: string }) =>
            createElement("button", { ...props, type: "button" }),
        VSCodeLink: (props: import("react").AnchorHTMLAttributes<HTMLAnchorElement>) => createElement("a", props),
    }
})
vi.mock("@/context/ExtensionStateContext", () => ({
    useExtensionState: () => ({ environment: "production", apiConfiguration: {}, mode: "act" }),
}))
vi.mock("@/context/ClineAuthContext", () => ({
    useClineSignIn: () => ({ isLoginLoading: false, handleSignIn: vi.fn() }),
}))
vi.mock("@/services/grpc-client", () => ({
    AccountServiceClient: { accountLoginClicked: vi.fn().mockResolvedValue({}) },
    StateServiceClient: { setWelcomeViewCompleted: vi.fn().mockResolvedValue({}) },
    TaskServiceClient: { newTask: vi.fn().mockResolvedValue({}) },
}))
vi.mock("@/assets/DlineLogo", () => ({ default: () => null }))
vi.mock("@/utils/validate", () => ({ validateApiConfiguration: vi.fn() }))
vi.mock("@/components/settings/ApiOptions", async () => {
    const { createElement } = await import("react")
    return { default: () => createElement("input", { "aria-label": "Provider draft" }) }
})
vi.mock("virtual:dline-whats-new", () => ({
    localizedReleases: { en: { version: "9.9.9", items: [] }, "zh-CN": { version: "9.9.9", items: [] } },
}))

// Each set is an independent semantic contract, not merely a placeholder count.
const richSentences = [
    ["shell.welcome.quickWins.heading", ["accent"]],
    ["shell.welcome.legacy.capability", ["model", "permission"]],
    ["shell.whatsNew.changelog", ["link"]],
    ["shell.whatsNew.star", ["link"]],
    ["shell.account.welcome.legal", ["terms", "privacy"]],
    ["shell.worktrees.include.tip", ["label", "includeFile", "exampleDirectory"]],
    ["shell.worktrees.merge.description", ["sourceBranch", "targetBranch"]],
    ["shell.worktrees.delete.description", ["path"]],
    ["shell.worktrees.delete.alsoBranch", ["branch"]],
] as const

type RichSentenceKey = (typeof richSentences)[number][0]

function richTemplate(language: UiLanguage, key: RichSentenceKey): string {
    switch (key) {
        case "shell.worktrees.include.tip":
            return translateUi(language, key, {
                label: "{label}",
                includeFile: "{includeFile}",
                exampleDirectory: "{exampleDirectory}",
            })
        case "shell.worktrees.merge.description":
            return translateUi(language, key, { sourceBranch: "{sourceBranch}", targetBranch: "{targetBranch}" })
        case "shell.worktrees.delete.description":
            return translateUi(language, key, { path: "{path}" })
        case "shell.worktrees.delete.alsoBranch":
            return translateUi(language, key, { branch: "{branch}" })
        default:
            return translateUi(language, key)
    }
}

function slotNames(text: string): string[] {
    return Array.from(text.matchAll(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g), ([, name]) => name).sort()
}

// Independent copy expectations: resource-to-resource equality alone cannot prove a translation.
const shellMessages = [
    // Navigation chrome
    ["shell.navigation.chat.name", "Chat", "对话"],
    ["shell.navigation.chat.tooltip", "New Task", "新建任务"],
    ["shell.navigation.history.name", "History", "历史"],
    ["shell.navigation.settings.tooltip", "Settings", "设置"],
    // Shared chrome
    ["shell.chrome.done", "Done", "完成"],
    ["shell.chrome.retry", "Retry", "重试"],
    ["shell.hydration.pending", "Loading Dline…", "正在加载 Dline…"],
    ["shell.errorBoundary.reload", "Reload panel", "重新加载面板"],
    ["shell.image.blocked", "External image blocked pending consent", "外部图片已阻止，等待你的许可"],
    ["shell.mermaid.copy", "Copy Code", "复制代码"],
    ["shell.codeAccordian.userEdits", "User Edits", "用户编辑"],
    ["shell.checkpoint.restoreBoth", "Restore Task and Workspace", "恢复任务与工作区"],
    ["shell.checkmark.label", "Checkpoint", "检查点"],
    ["shell.metric.tokens", "Token consumption", "Token 消耗"],
    // History
    ["shell.history.title", "History", "历史"],
    ["shell.history.searchPlaceholder", "Fuzzy search history...", "模糊搜索历史…"],
    ["shell.history.sort.newest", "Newest", "最新"],
    ["shell.history.filter.workspaceOnly", "Workspace Only", "仅当前工作区"],
    ["shell.history.group.today", "Today", "今天"],
    ["shell.history.selectAll", "Select All", "全选"],
    ["shell.historyItem.openTask", "Open Task", "打开任务"],
    ["shell.historyPreview.recent", "Recent", "最近"],
    ["shell.historyPreview.empty", "No recent tasks", "暂无最近任务"],
    ["shell.completion.completed", "Completed", "已完成"],
    ["shell.taskUsage.totalCost", "Total cost", "总花费"],
    // Account
    ["shell.account.title", "Account", "账户"],
    ["shell.account.personal", "Personal", "个人"],
    ["shell.account.dashboard", "Dashboard", "控制台"],
    ["shell.account.logOut", "Log out", "退出登录"],
    ["shell.account.credits.label", "CURRENT BALANCE", "当前余额"],
    ["shell.account.history.usageTab", "USAGE HISTORY", "用量历史"],
    ["shell.account.history.emptyPayments", "No payment history", "暂无付款历史"],
    ["shell.account.role.owner", "Owner", "所有者"],
    // Onboarding and welcome
    ["shell.onboarding.step0.title", "How will you use Dline?", "你将如何使用 Dline？"],
    ["shell.onboarding.button.continue", "Continue", "继续"],
    ["shell.welcome.heading", "What can I do for you?", "有什么可以帮你？"],
    ["shell.welcome.takeTour", "Take a Tour", "快速导览"],
    ["shell.welcome.quickWin.nextjs.title", "Build a Next.js App", "构建 Next.js 应用"],
    ["shell.welcome.legacy.getStarted", "Get Started for Free", "免费开始使用"],
    ["shell.whatsNew.starAria", "Star us on GitHub", "在 GitHub 上为我们加星"],
    // Worktrees
    ["shell.worktrees.title", "Worktrees", "工作树"],
    ["shell.worktrees.done", "Done", "完成"],
    ["shell.worktrees.empty", "No worktrees found.", "未找到工作树。"],
    ["shell.worktrees.badge.primary", "Primary", "主工作树"],
    ["shell.worktrees.merge.title", "Merge Worktree", "合并工作树"],
    ["shell.worktrees.delete.title", "Delete Worktree", "删除工作树"],
] as const

describe("shell UI resource", () => {
    it.each(shellMessages)("translates %s using independently specified copy", (key, english, chinese) => {
        expect(translateUi("en", key)).toBe(english)
        expect(translateUi("zh-CN", key)).toBe(chinese)
    })

    it("has exactly the same complete key set and message kinds in both resources", () => {
        expect(Object.keys(en)).toEqual(expect.arrayContaining(shellMessages.map(([key]) => key)))
        expect(Object.keys(zhCN).sort()).toEqual(Object.keys(en).sort())
        for (const key of Object.keys(en) as (keyof typeof en)[]) {
            expect(typeof zhCN[key]).toBe(typeof en[key])
        }
    })

    it.each(richSentences)("preserves the complete semantic slot-name set for %s", (key, names) => {
        for (const language of ["en", "zh-CN"] as const) {
            // Comparing the actual names (including repeats) catches substitutions,
            // omissions and duplicates even when the placeholder count is unchanged.
            expect(slotNames(richTemplate(language, key))).toEqual([...names].sort())
        }
    })

    it("includes every static rich sentence in the slot contract", () => {
        const contracted = new Set<string>(richSentences.map(([key]) => key))
        for (const resource of [en, zhCN]) {
            for (const [key, message] of Object.entries(resource)) {
                if (typeof message === "string" && slotNames(message).length > 0) {
                    expect(contracted.has(key), `Missing rich sentence contract: ${key}`).toBe(true)
                }
            }
        }
    })

    it("is assembled into the root catalog under the shell prefix only", () => {
        for (const key of Object.keys(en)) {
            expect(key.startsWith("shell.")).toBe(true)
        }
        expect(UI_MESSAGES.en["shell.navigation.history.tooltip"]).toBe(en["shell.navigation.history.tooltip"])
        expect(UI_MESSAGES["zh-CN"]["shell.navigation.history.tooltip"]).toBe(zhCN["shell.navigation.history.tooltip"])
    })

    it("keeps named arguments at the same positions and renders them as literal text", () => {
        expect(translateUi("en", "shell.chrome.environmentSuffix", { environment: "Staging" })).toBe("Staging environment")
        expect(translateUi("zh-CN", "shell.chrome.environmentSuffix", { environment: "预发布" })).toBe("预发布环境")

        expect(translateUi("en", "shell.history.lockedMany", { count: 3 })).toBe(
            "3 task(s) are currently in use by another instance and were not deleted.",
        )
        expect(translateUi("zh-CN", "shell.history.lockedMany", { count: 3 })).toBe("3 个任务正被另一个实例使用，未被删除。")

        // A dynamic value is literal text, never a template or executable source.
        const injected = "<strong>${path}</strong>"
        expect(translateUi("en", "shell.markdown.openInEditor", { path: injected })).toBe(
            "Open <strong>${path}</strong> in editor",
        )
        expect(translateUi("zh-CN", "shell.markdown.openInEditor", { path: injected })).toBe(
            "在编辑器中打开 <strong>${path}</strong>",
        )
    })

    it("resolves the task-title and date placeholders from data, not translation", () => {
        // Task titles and timestamps are user data: they must pass through unchanged.
        const title = "Investigate delete behavior"
        expect(translateUi("zh-CN", "shell.historyPreview.lastEdited", { timestamp: "2026/01/01 02:03:04" })).toBe(
            "最后编辑于 2026/01/01 02:03:04",
        )
        expect(translateUi("zh-CN", "shell.taskUsage.totalTokens", { count: "1,300" })).toBe("Token 总数：1,300")
        expect(title).toBe("Investigate delete behavior")
    })

    it("counts deletion selection without changing the count argument", () => {
        expect(translateUi("en", "shell.history.deleteSelectedCount", { count: 1, size: "" })).toBe("Delete Selected")
        expect(translateUi("zh-CN", "shell.history.deleteSelectedCount", { count: 1, size: "" })).toBe("删除所选项目")
        expect(translateUi("en", "shell.history.deleteSelectedCount", { count: 4, size: "12.3 KB" })).toBe(
            "Delete 4 Selected (12.3 KB)",
        )
        expect(translateUi("zh-CN", "shell.history.deleteSelectedCount", { count: 4, size: "12.3 KB" })).toBe(
            "删除 4 个所选项目（12.3 KB）",
        )
        expect(translateUi("zh-CN", "shell.history.deleteAllCount", { size: "" })).toBe("删除全部历史")
    })

    it("explains partial checkpoint coverage with every argument kept", () => {
        expect(
            translateUi("en", "shell.checkmark.partialCoverage", {
                label: "Checkpoint",
                available: 1,
                total: 2,
                restored: false,
            }),
        ).toBe("Checkpoint (1/2 workspaces)")
        expect(
            translateUi("zh-CN", "shell.checkmark.partialCoverage", {
                label: "检查点",
                available: 1,
                total: 2,
                restored: true,
            }),
        ).toBe("检查点（1/2 个工作区，已恢复）")
    })
})

interface RenderedRichSentence {
    name: string
    view: () => ReactNode
    sentence: () => HTMLElement
    text: readonly [string, string]
    slots: ReadonlyArray<{
        tag: string
        labels: readonly [string, string]
        attributes?: Readonly<Record<string, string>>
    }>
}

const renderedRichSentences: RenderedRichSentence[] = [
    {
        name: "quick-win emphasis",
        view: () => createElement(SuggestedTasks, { shouldShowQuickWins: true }),
        sentence: () => screen.getByRole("heading", { name: "Quick [Wins] with Dline" }),
        text: ["Quick [Wins] with Dline", "用 Dline 轻松搞定"],
        slots: [{ tag: "SPAN", labels: ["[Wins]", "轻松搞定"] }],
    },
    {
        name: "legacy model link and permission emphasis",
        view: () => createElement(WelcomeView),
        sentence: () => screen.getByRole("link", { name: "Claude 4.6 Sonnet's" }).closest("p")!,
        text: [
            "I can even use MCP to create new tools and extend my own capabilities.",
            "我甚至可以使用 MCP 创建新工具并扩展自身能力。",
        ],
        slots: [
            {
                tag: "A",
                labels: ["Claude 4.6 Sonnet's", "Claude 4.6 Sonnet"],
                attributes: { href: "https://www.anthropic.com/claude/sonnet" },
            },
            { tag: "I", labels: ["(with your permission, of course)", "（当然，是在你允许的前提下）"] },
        ],
    },
    {
        name: "changelog link",
        view: () => createElement(WhatsNewItems, { inlineCodeStyle: {} }),
        sentence: () => screen.getByRole("link", { name: "full changelog" }).closest("p")!,
        text: ["See the full changelog for every change.", "查看完整更新日志了解全部变更。"],
        slots: [
            {
                tag: "A",
                labels: ["full changelog", "完整更新日志"],
                attributes: { target: "_blank", rel: "noopener noreferrer" },
            },
        ],
    },
    {
        name: "repository star link",
        view: () => createElement(WhatsNewModal, { open: true, onClose: vi.fn(), version: "9.9.9" }),
        sentence: () => screen.getByRole("link", { name: "starring us on GitHub" }).closest("p")!,
        text: ["Please support Dline by starring us on GitHub.", "请通过在 GitHub 上为我们加星支持 Dline。"],
        slots: [
            {
                tag: "A",
                labels: ["starring us on GitHub", "在 GitHub 上为我们加星"],
                attributes: { href: DLINE_REPOSITORY_URL, target: "_blank", rel: "noopener noreferrer" },
            },
        ],
    },
    {
        name: "legal links",
        view: () => createElement(AccountWelcomeView),
        sentence: () => screen.getByRole("link", { name: "Terms of Service" }).closest("p")!,
        text: ["By continuing, you agree to the Terms of Service and Privacy Policy.", "继续即表示你同意服务条款和隐私政策。"],
        slots: [
            { tag: "A", labels: ["Terms of Service", "服务条款"], attributes: { href: "https://dline.cc/terms" } },
            { tag: "A", labels: ["Privacy Policy", "隐私政策"], attributes: { href: "https://docs.dline.cc/privacy/" } },
        ],
    },
]

describe("shell complete rich sentences in actual consumers", () => {
    it.each(renderedRichSentences)("keeps $name slots mounted and semantic in both directions", ({
        name,
        view,
        sentence: findSentence,
        text,
        slots: contract,
    }) => {
        const children = view()
        const localized = (language: UiLanguage) => createElement(UiLanguageProvider, { language, children })
        const { rerender } = render(localized("en"))
        const sentence = findSentence()
        const elements = Array.from(sentence.children)
        const hrefs = elements.map((element) => element.getAttribute("href"))
        expect(elements).toHaveLength(contract.length)
        if (name === "changelog link") {
            expect(hrefs[0]).toMatch(/\/docs\/changelog\/CHANGELOG_en\.md$/)
        }

        // Exercise the legacy disclosure/draft as well as its inline link slots.
        const showProvider = screen.queryByRole("button", { name: "Use your own API key" })
        if (showProvider) {
            fireEvent.click(showProvider)
            fireEvent.input(screen.getByRole("textbox", { name: "Provider draft" }), { target: { value: "user draft" } })
        }
        const draft = screen.queryByRole("textbox", { name: "Provider draft" })

        for (const language of ["en", "zh-CN", "en"] as const) {
            rerender(localized(language))
            const edition = language === "en" ? 0 : 1
            expect(sentence).toBeInTheDocument()
            expect(sentence.children).toHaveLength(elements.length)
            expect(sentence).toHaveTextContent(text[edition])
            expect(sentence.textContent).not.toMatch(/\{[a-zA-Z][a-zA-Z0-9]*\}/)
            contract.forEach(({ tag, labels, attributes }, index) => {
                const element = sentence.children[index]
                expect(element).toBe(elements[index])
                expect(element.tagName).toBe(tag)
                expect(element).toHaveTextContent(labels[edition])
                const expectedHref =
                    name === "changelog link" && language === "zh-CN"
                        ? hrefs[index]!.replace(/\/docs\/changelog\/CHANGELOG_en\.md$/, "/CHANGELOG.md")
                        : hrefs[index]
                expect(element.getAttribute("href")).toBe(expectedHref)
                for (const [name, value] of Object.entries(attributes ?? {})) {
                    expect(element).toHaveAttribute(name, value)
                }
            })
            if (draft) {
                expect(screen.getByRole("textbox", { name: "Provider draft" })).toBe(draft)
                expect(draft).toHaveValue("user draft")
                expect(screen.queryByRole("button", { name: /Use your own API key|使用自己的 API 密钥/ })).toBeNull()
            }
        }
    })
})
