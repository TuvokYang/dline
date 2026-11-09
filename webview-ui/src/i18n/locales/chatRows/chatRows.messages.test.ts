import { describe, expect, it } from "vitest"
import { translateUi, type UiMessageArgs, type UiMessageKey } from "../../messages"
import { en } from "./en"
import { zhCN } from "./zh_CN"

/**
 * Independent copy expectations.
 *
 * Comparing the two resources to each other cannot prove a translation, so the
 * pairs are written out here and read against the catalogs.
 */
const expectedCopy: ReadonlyArray<readonly [keyof typeof en, string, string]> = [
    ["chatRows.errors.apiRequestFailed", "API Request Failed", "API 请求失败"],
    ["chatRows.common.copyError", "Copy error", "复制错误"],
    ["chatRows.errors.field.provider", "Provider", "提供方"],
    ["chatRows.errors.field.httpStatus", "HTTP status", "HTTP 状态"],
    ["chatRows.errors.unknownApiError", "Unknown API error", "未知的 API 错误"],
    [
        "chatRows.errors.compaction.missingBlock",
        "The reply did not contain a <summarize_task> block.",
        "回复中没有 <summarize_task> 块。",
    ],
    ["chatRows.header.taskCompleted", "Task Completed", "任务已完成"],
    ["chatRows.header.readFile", "Dline wants to read this file:", "Dline 想要读取此文件："],
    ["chatRows.header.loadedSkill", "Dline loaded the skill:", "Dline 已加载技能："],
    ["chatRows.capability.unnamed", "Unnamed capability", "未命名能力"],
    ["chatRows.kill.terminated", "Command terminated", "命令已终止"],
    [
        "chatRows.command.requestsApproval",
        "The model has determined this command requires explicit approval.",
        "模型判断此命令需要显式批准。",
    ],
    ["chatRows.command.status.success", "Success", "成功"],
    ["chatRows.activity.empty", "No matching activities.", "没有匹配的活动。"],
    ["chatRows.activity.tabs.work", "Work", "工作"],
    ["chatRows.subagent.unavailable", "Subagent status update unavailable.", "子代理状态更新不可用。"],
    ["chatRows.subagent.section.output", "Output", "输出"],
    ["chatRows.browser.phase.completed", "Dline used the browser", "Dline 使用了浏览器"],
    ["chatRows.browser.action.scrollDown", "Scroll down", "向下滚动"],
    ["chatRows.browser.message.pageCaptured", "Browser page captured", "已捕获浏览器页面"],
    ["chatRows.transition.compactAndSwitch", "Compact & Switch", "压缩并切换"],
    ["chatRows.transition.sourceDefault", "source settings", "源设置"],
    ["chatRows.menu.mention.noResults", "No results found", "未找到结果"],
    ["chatRows.menu.servers.settings", "Go to MCP server settings", "前往 MCP 服务器设置"],
    ["chatRows.usage.heading", "Usage", "用量"],
    ["chatRows.common.tip", "Tip:", "提示："],
    ["chatRows.env.tab.startup", "Startup Scripts", "启动脚本"],
    ["chatRows.user.queued", "Queued input", "已排队输入"],
    ["chatRows.hook.status.aborted", "Aborted", "已中止"],
    ["chatRows.reportBug.environment.version", "Dline version", "Dline 版本"],
    ["chatRows.image.status.rejected", "Image generation rejected", "图片生成被拒绝"],
    ["chatRows.completion.explainChanges", "Explain Changes", "解释更改"],
    ["chatRows.autoRetry.retryingNow", "Retrying now", "正在重试"],
    ["chatRows.thinking.content", "Thinking content", "思考内容"],
    ["chatRows.quote.title", "Quote selection in reply", "在回复中引用所选内容"],
    ["chatRows.plan.created", "Plan Created", "计划已创建"],
    ["chatRows.focusChain.autoApproved", "Auto Approved", "已自动批准"],
    ["chatRows.newTask.mode", "Mode", "模式"],
    ["chatRows.qna.title", "Q&A", "问答"],
    ["chatRows.searchResults.expand", "Expand search results", "展开搜索结果"],
    ["chatRows.feedback.helpful", "This was helpful", "这很有帮助"],
    ["chatRows.agentUpdate.phaseReport", "Phase report", "阶段报告"],
    [
        "chatRows.deferred.search",
        "Waiting for the local tool results. The provider runs this search with the next request.",
        "正在等待本地工具结果。提供方会在下一次请求时执行此搜索。",
    ],
    ["chatRows.mcp.collapseCall", "Collapse MCP call", "收起 MCP 调用"],
    ["chatRows.report.defaultTitle", "Report", "报告"],
    ["chatRows.edit.processing", "Processing...", "正在处理…"],
    ["chatRows.common.status.running", "Running", "运行中"],
]

function messageCase<K extends UiMessageKey>(key: K, args: UiMessageArgs<K>, english: string, chinese: string) {
    return {
        key,
        english,
        chinese,
        renderEnglish: () => translateUi("en", key, ...args),
        renderChinese: () => translateUi("zh-CN", key, ...args),
    }
}

const dynamicCases = [
    messageCase(
        "chatRows.header.mcpUseTool",
        [{ server: "srv" }],
        "Dline wants to use a tool on the srv MCP server:",
        "Dline 想要在 srv MCP 服务器上使用工具：",
    ),
    messageCase(
        "chatRows.header.mcpAccessResource",
        [{ server: "srv" }],
        "Dline wants to access a resource on the srv MCP server:",
        "Dline 想要访问 srv MCP 服务器上的资源：",
    ),
    messageCase(
        "chatRows.header.searchFiles",
        [{ regex: "needle" }],
        "Dline wants to search this directory for needle:",
        "Dline 想要在此目录中搜索 needle：",
    ),
    messageCase("chatRows.capability.loading", [{ kind: "Skill" }], "Loading Skill", "正在加载Skill"),
    messageCase("chatRows.capability.failed", [{ kind: "Skill" }], "Failed to load Skill", "加载Skill失败"),
    messageCase("chatRows.webSearch.showResults", [{ count: 3 }], "Show results (3)", "显示结果（3）"),
    messageCase("chatRows.image.count", [{ count: 2 }], "2 images requested", "已请求 2 张图片"),
    messageCase("chatRows.subagent.retry", [{ attempt: 1, maxRetries: 3 }], "Retry 1/3", "重试 1/3"),
    messageCase("chatRows.subagent.toolCalls", [{ count: 1 }], "1 tool", "1 个工具"),
    messageCase("chatRows.subagent.toolCalls", [{ count: 4 }], "4 tools", "4 个工具"),
    messageCase("chatRows.browser.action.click", [{ coordinate: "20, 30" }], "Click (20, 30)", "点击（20, 30）"),
    messageCase("chatRows.browser.summary.click", [{ count: 1 }], "1 click", "1 次点击"),
    messageCase("chatRows.browser.summary.click", [{ count: 3 }], "3 clicks", "3 次点击"),
    messageCase("chatRows.browser.summary.thought", [{ count: 1 }], "1 thought", "1 次思考"),
    messageCase("chatRows.browser.summary.thought", [{ count: 2 }], "2 thoughts", "2 次思考"),
    messageCase("chatRows.compaction.attempt", [{ attempt: 1, maxAttempts: 3 }], "Attempt 1 of 3", "第 1 次尝试，共 3 次"),
    messageCase("chatRows.autoRetry.nextRetry", [{ seconds: 12 }], "Next retry in 12s", "12 秒后重试"),
    messageCase(
        "chatRows.autoRetry.exhausted",
        [{ maxAttempts: 3 }],
        "All 3 automatic attempts were used.",
        "已用完全部 3 次自动尝试。",
    ),
    messageCase("chatRows.newTask.contexts", [{ count: 4 }], "4 contexts", "4 段上下文"),
    messageCase("chatRows.env.environmentName", [{ index: 2 }], "Environment name 2", "环境变量名称 2"),
    messageCase("chatRows.common.executionMode", [{ mode: "Background" }], "Execution mode: Background", "执行模式：Background"),
    messageCase("chatRows.hook.exitCode", [{ code: 2 }], "(exit: 2)", "（退出码：2）"),
    messageCase("chatRows.image.artifactMeta", [{ width: 64, height: 64, format: "PNG" }], "64×64 · PNG", "64×64 · PNG"),
    messageCase(
        "chatRows.requestStart.regexPatternIn",
        [{ path: "a.ts", pattern: "x", terms: "find | b" }],
        '"find | b" in a.ts/ (x)',
        "a.ts/ 中的“find | b”（x）",
    ),
    messageCase("chatRows.codeExecution.exitCode", [{ code: 1 }], "Exit code: 1", "退出代码：1"),
    messageCase(
        "chatRows.errors.spendLimitMessage",
        [{ limit: "5.00", period: "daily" }],
        "$5.00 daily limit has been reached.",
        "已达到 daily上限 $5.00。",
    ),
]

describe("chatRows bilingual resource", () => {
    it.each(expectedCopy)("translates %s with independently specified copy", (key, english, chinese) => {
        expect(en[key]).toBe(english)
        expect(zhCN[key]).toBe(chinese)
    })

    it("defines exactly the same key set and message kinds in both resources", () => {
        expect(Object.keys(zhCN).sort()).toEqual(Object.keys(en).sort())
        for (const key of Object.keys(en) as (keyof typeof en)[]) {
            expect(typeof zhCN[key]).toBe(typeof en[key])
        }
    })

    it.each(dynamicCases)("renders $key from its typed named arguments", ({ renderEnglish, renderChinese, english, chinese }) => {
        expect(renderEnglish()).toBe(english)
        expect(renderChinese()).toBe(chinese)
    })

    it("treats every dynamic value as literal text rather than a template", () => {
        const injected = "<strong>${server}</strong>"
        expect(translateUi("en", "chatRows.header.mcpUseTool", { server: injected })).toBe(
            `Dline wants to use a tool on the ${injected} MCP server:`,
        )
        expect(translateUi("zh-CN", "chatRows.header.mcpUseTool", { server: injected })).toBe(
            `Dline 想要在 ${injected} MCP 服务器上使用工具：`,
        )
    })
})
