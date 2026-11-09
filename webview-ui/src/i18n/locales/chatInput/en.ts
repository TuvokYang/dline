import { composerEn } from "./composer.en"
import { headerEn } from "./header.en"
import { interactionEn } from "./interaction.en"
import { timelineEn } from "./timeline.en"

/** Product-owned chat/composer presentation only. Never translate message or tool payloads here. */
export const en = {
    ...composerEn,
    ...interactionEn,
    ...headerEn,
    ...timelineEn,
    "chatInput.common.cancel": "Cancel",
    "chatInput.common.yes": "Yes",
    "chatInput.context.title": "Context Window",
    "chatInput.context.durable": "Durable",
    "chatInput.context.sending": "Sending",
    "chatInput.context.receiving": "Receiving",
    "chatInput.context.staged": "Staged",
    "chatInput.context.environment": "ENV",
    "chatInput.context.used": "Used",
    "chatInput.context.remaining": "Remaining",
    "chatInput.context.total": "Total",
    "chatInput.context.part.basePrompt": "System prompt",
    "chatInput.context.part.userRules": "User rules",
    "chatInput.context.part.skills": "Skills",
    "chatInput.context.part.workflows": "Workflows",
    "chatInput.context.part.toolDefinitions": "Tool definitions",
    "chatInput.context.part.mcpToolDefinitions": "MCP",
    "chatInput.context.part.conversation": "Conversation",
    "chatInput.context.breakdownUnavailable": "Breakdown unavailable until the next request is measured.",
    "chatInput.context.segmentsUnavailable": "Segment details unavailable for this saved task.",
    "chatInput.context.showBreakdown": "Show what the durable context is made of",
    "chatInput.context.progress": "Context window usage progress",
    "chatInput.context.phase.stable": "stable",
    "chatInput.context.phase.sending": "sending",
    "chatInput.context.phase.receiving": "receiving",
    "chatInput.context.phase.committing": "committing",
    "chatInput.context.phase.rolling_back": "rolling back",
    "chatInput.context.usage": ({ used, total, phase }: { used: number; total: number; phase: string }) =>
        `${used} of ${total} tokens; phase ${phase}`,
    "chatInput.context.segmentUsage": ({ label, tokens }: { label: string; tokens: number }) => `${label}: ${tokens} tokens`,
    "chatInput.context.currentTokens": "Current tokens used in this request",
    "chatInput.context.maximumTokens": "Maximum context window size for this model",
    "chatInput.context.compactQuestion": "Compact the current task?",
    "chatInput.context.keepTask": "No, keep the task as is",
    "chatInput.context.confirmCompact": "Yes, compact the task",
    "chatInput.context.truncateQuestion": "Force truncate conversation history?",
    "chatInput.context.truncateWarning":
        "This permanently removes older conversation history from future requests. Use it only when automatic context compaction has failed and Retry cannot recover the task.",
    "chatInput.context.truncateConfirm": ({ confirmation }: { confirmation: string }) => `Type ${confirmation} to confirm.`,
    "chatInput.context.truncateAria": "Type TRUNCATE to confirm",
    "chatInput.context.truncateAction": "Force truncate conversation history",
} as const
