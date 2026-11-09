import type { UiResource } from "../../resource"
import { composerZhCN } from "./composer.zh_CN"
import type { en } from "./en"
import { headerZhCN } from "./header.zh_CN"
import { interactionZhCN } from "./interaction.zh_CN"
import { timelineZhCN } from "./timeline.zh_CN"

export const zhCN = {
    ...composerZhCN,
    ...interactionZhCN,
    ...headerZhCN,
    ...timelineZhCN,
    "chatInput.common.cancel": "取消",
    "chatInput.common.yes": "是",
    "chatInput.context.title": "上下文窗口",
    "chatInput.context.durable": "持久上下文",
    "chatInput.context.sending": "发送中",
    "chatInput.context.receiving": "接收中",
    "chatInput.context.staged": "待发送",
    "chatInput.context.environment": "环境",
    "chatInput.context.used": "已用",
    "chatInput.context.remaining": "剩余",
    "chatInput.context.total": "总计",
    "chatInput.context.part.basePrompt": "系统提示词",
    "chatInput.context.part.userRules": "用户规则",
    "chatInput.context.part.skills": "技能",
    "chatInput.context.part.workflows": "工作流",
    "chatInput.context.part.toolDefinitions": "工具定义",
    "chatInput.context.part.mcpToolDefinitions": "MCP",
    "chatInput.context.part.conversation": "对话",
    "chatInput.context.breakdownUnavailable": "下次请求完成测量后才可查看明细。",
    "chatInput.context.segmentsUnavailable": "此已保存任务没有分段明细。",
    "chatInput.context.showBreakdown": "查看持久上下文的组成",
    "chatInput.context.progress": "上下文窗口使用进度",
    "chatInput.context.phase.stable": "稳定",
    "chatInput.context.phase.sending": "发送中",
    "chatInput.context.phase.receiving": "接收中",
    "chatInput.context.phase.committing": "提交中",
    "chatInput.context.phase.rolling_back": "回滚中",
    "chatInput.context.usage": ({ used, total, phase }) => `已用 ${used} / ${total} 个 token；阶段：${phase}`,
    "chatInput.context.segmentUsage": ({ label, tokens }) => `${label}：${tokens} 个 token`,
    "chatInput.context.currentTokens": "当前请求已使用的 token 数",
    "chatInput.context.maximumTokens": "此模型的最大上下文窗口大小",
    "chatInput.context.compactQuestion": "压缩当前任务？",
    "chatInput.context.keepTask": "否，保持任务不变",
    "chatInput.context.confirmCompact": "是，压缩任务",
    "chatInput.context.truncateQuestion": "强制截断对话历史？",
    "chatInput.context.truncateWarning":
        "这会从后续请求中永久移除较早的对话历史。仅在自动上下文压缩失败且重试无法恢复任务时使用。",
    "chatInput.context.truncateConfirm": ({ confirmation }) => `输入 ${confirmation} 以确认。`,
    "chatInput.context.truncateAria": "输入 TRUNCATE 以确认",
    "chatInput.context.truncateAction": "强制截断对话历史",
} satisfies UiResource<typeof en>
