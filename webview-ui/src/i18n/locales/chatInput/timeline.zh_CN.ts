import type { UiResource } from "../../resource"
import type { timelineEn } from "./timeline.en"

export const timelineZhCN = {
    "chatInput.welcome.current": ({ label, branch }) => `${label}${branch}`,
    "chatInput.welcome.currentLabel": "当前：",
    "chatInput.welcome.detached": "分离的 HEAD",
    "chatInput.welcome.worktrees": "查看和管理 Git 工作树，方便并行运行 Dline 任务。",
    "chatInput.timeline.collapseAll": "收起所有活动",
    "chatInput.timeline.expandAll": "展开所有活动",
    "chatInput.timeline.bottom": "滚动到底部",
    "chatInput.timeline.top": "滚动到顶部",
    "chatInput.timeline.thinking": "思考",
    "chatInput.trajectory.title": "对话轨迹",
    "chatInput.trajectory.jump": ({ prompt }) => `跳转到消息：${prompt}`,
    "chatInput.trajectory.attempt": ({ number }) => `第 ${number} 阶段`,
    "chatInput.trajectory.turn": ({ number }) => `第 ${number} 轮对话`,
    "chatInput.trajectory.rounds": ({ count }) => `${count} 轮请求`,
    "chatInput.fold.rounds": ({ count }) => `${count} 轮请求`,
    "chatInput.fold.work.read": ({ count }) => `${count} 次文件读取`,
    "chatInput.fold.work.write": ({ count }) => `${count} 次文件编辑`,
    "chatInput.fold.work.command": ({ count }) => `${count} 条命令`,
    "chatInput.fold.work.subagent": ({ count }) => `${count} 个子代理`,
    "chatInput.fold.work.web": ({ count }) => `${count} 次网络工具调用`,
    "chatInput.fold.work.browser": ({ count }) => `${count} 次浏览器操作`,
    "chatInput.fold.work.other": ({ count }) => `${count} 次其他操作`,
    "chatInput.fold.mcp": ({ servers, tools, failed }) => `${servers} 个 MCP（${tools} 次工具调用，${failed} 次失败）`,
    "chatInput.fold.thoughts": ({ count }) => `${count} 段思考`,
    "chatInput.fold.checkpoints": ({ count }) => `${count} 个检查点`,
    "chatInput.fold.messages": ({ count }) => `${count} 条消息`,
    "chatInput.fold.withExternal": ({ work, external }) => `${work}（${external} 次位于工作区外）`,
    "chatInput.fold.failure.edit": ({ count }) => `${count} 次文件编辑失败`,
    "chatInput.fold.failure.read": ({ count }) => `${count} 次文件读取失败`,
    "chatInput.fold.failure.subagent": ({ count }) => `${count} 个子代理失败`,
    "chatInput.fold.failure.command": ({ count }) => `${count} 条命令失败`,
    "chatInput.fold.failure.web": ({ count }) => `${count} 次网络工具调用失败`,
    "chatInput.fold.failure.browser": ({ count }) => `${count} 次浏览器操作失败`,
    "chatInput.fold.finished": "已完成的步骤",
    "chatInput.fold.subagents": ({ agents }) => `子代理：${agents}`,
    "chatInput.fold.external": ({ work }) => `工作区外操作：${work}`,
    "chatInput.fold.kind.read": "读取",
    "chatInput.fold.kind.write": "编辑",
    "chatInput.fold.kind.command": "命令",
    "chatInput.fold.kind.subagent": "子代理",
    "chatInput.fold.kind.web": "网络",
    "chatInput.fold.kind.browser": "浏览器",
    "chatInput.fold.kind.other": "其他",
    "chatInput.fold.usageTokens": ({ input, output }) => `输入 ${input} / 输出 ${output}`,
    "chatInput.tool.matchScale": ({ count, files, truncated }) =>
        `（${count}${truncated ? "+" : ""} 处匹配${files ? ` · ${files} 个文件` : ""}）`,
    "chatInput.tool.refScale": ({ count, files, truncated }) =>
        `（${count}${truncated ? "+" : ""} 处引用${files ? ` · ${files} 个文件` : ""}）`,
    "chatInput.tool.searchDisplay": ({ target, path, suffix }) => `${target} 位于 ${path}${suffix}`,
    "chatInput.tool.inSeparator": " 位于 ",
    "chatInput.tool.references": "引用",
    "chatInput.tool.lines": ({ start, end }) => `第 ${start}-${end} 行`,
    "chatInput.tool.reading": ({ path, start, end, pending }) =>
        `正在读取 ${path}${start != null && end != null ? `（第 ${start}-${end} 行）` : ""}${pending ? "…" : ""}`,
    "chatInput.tool.readingPrefix": "正在读取",
    "chatInput.tool.exploring": ({ path, pending }) => `正在浏览 ${path}/${pending ? "…" : ""}`,
    "chatInput.tool.exploringPrefix": "正在浏览",
    "chatInput.tool.searching": ({ target, pending }) => `正在搜索 ${target}${pending ? "…" : ""}`,
    "chatInput.tool.finding": ({ target, pending }) => `正在查找 ${target}${pending ? "…" : ""}`,
    "chatInput.tool.analyzing": ({ path, pending }) => `正在分析 ${path}/${pending ? "…" : ""}`,
    "chatInput.tool.analyzingPrefix": "正在分析",
    "chatInput.tool.preview": "（预览）",
    "chatInput.tool.rename": ({ count, files, preview, name }) =>
        `${files} 个文件中有 ${count} 处更改${preview ? "（预览）" : ""}${name ? ` → “${name}”` : ""}`,
    "chatInput.tool.replace": ({ count, files, preview, find }) =>
        find
            ? `“${find}” →（${files} 个文件中的 ${count} 处）${preview ? "（预览）" : ""}`
            : `${files} 个文件中有 ${count} 处更改`,
    "chatInput.tool.summary": ({ read, list, def, search, refs }) => {
        const parts = [
            read ? `读取 ${read} 个文件` : "",
            list ? `浏览 ${list} 个目录` : "",
            def ? `查看 ${def} 处定义` : "",
            search ? `执行 ${search} 次搜索` : "",
            refs ? `找到 ${refs} 处引用` : "",
        ].filter(Boolean)
        return parts.length ? `Dline ${parts.join("，")}` : "上下文"
    },
    "chatInput.tool.exploration": ({ tools, thoughts, rounds }) =>
        [tools, thoughts > 0 ? `${thoughts} 段思考` : "", rounds > 1 ? `${rounds} 轮请求` : ""].filter(Boolean).join(" · "),
} satisfies UiResource<typeof timelineEn>
