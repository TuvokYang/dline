import { readCommandRow } from "@shared/commandRow"
import type { UiMessage, UiSayTool } from "@shared/ExtensionMessage"
import { parseImageGenerationToolText } from "@shared/image-generation"
import { parseNewTaskAsk } from "@shared/new-task-ask"
import { useState } from "react"
import { ApiFailureContent } from "@/components/chat/ApiFailureContent"
import ImageGenerationRow from "@/components/chat/ImageGenerationRow"
import NewTaskPreview from "@/components/chat/NewTaskPreview"
import ReportBugPreview from "@/components/chat/ReportBugPreview"
import { CopyButton } from "@/components/common/CopyButton"
import type { UiTranslator } from "@/i18n/messages"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"

/** Props shared by pure interaction presentation renderers. */
export interface PresentationProps {
    message: UiMessage
    selection: string[]
    onSelectionChange: (selection: string[]) => void
}

/** Render one pure presentation shell. */
function shell(message: UiMessage) {
    return <div>{message.text}</div>
}

const TOOL_APPROVAL_TITLES = {
    editedExistingFile: "chatInput.approval.editedExistingFile",
    newFileCreated: "chatInput.approval.newFileCreated",
    fileDeleted: "chatInput.approval.fileDeleted",
    readFile: "chatInput.approval.readFile",
    listFilesTopLevel: "chatInput.approval.listFilesTopLevel",
    listFilesRecursive: "chatInput.approval.listFilesRecursive",
    listCodeDefinitionNames: "chatInput.approval.listCodeDefinitionNames",
    searchFiles: "chatInput.approval.searchFiles",
    webFetch: "chatInput.approval.webFetch",
    webSearch: "chatInput.approval.webSearch",
    codeExecution: "chatInput.approval.codeExecution",
    summarizeTask: "chatInput.approval.summarizeTask",
    useSkill: "chatInput.approval.useSkill",
    loadCapability: "chatInput.approval.loadCapability",
    findReferences: "chatInput.approval.findReferences",
    renameSymbol: "chatInput.approval.renameSymbol",
    replaceText: "chatInput.approval.replaceText",
    focusChainChanged: "chatInput.approval.focusChainChanged",
    statusUpdate: "chatInput.approval.statusUpdate",
    actModeRespond: "chatInput.approval.actModeRespond",
    killCommand: "chatInput.approval.killCommand",
    generateImage: "chatInput.approval.generateImage",
    genericTool: "chatInput.approval.genericTool",
} as const satisfies Record<UiSayTool["tool"], string>

function parseTool(text: string | undefined): UiSayTool | undefined {
    if (!text) return undefined
    try {
        const parsed = JSON.parse(text) as unknown
        if (typeof parsed !== "object" || parsed === null || !("tool" in parsed) || typeof parsed.tool !== "string") {
            return undefined
        }
        return parsed as UiSayTool
    } catch {
        return undefined
    }
}

function toolDetail(tool: UiSayTool, t: UiTranslator): string | undefined {
    if (tool.tool === "searchFiles" && tool.regex) {
        const path = tool.path || tool.filePattern
        return path ? t("chatInput.approval.searchIn", { regex: tool.regex, path }) : `"${tool.regex}"`
    }
    if (tool.symbolName) return tool.symbolName
    if (tool.path) return tool.path
    if (tool.filePattern) return tool.filePattern
    if (typeof tool.content === "string" && tool.content.trim()) return tool.content
    if (Array.isArray(tool.content) && tool.content.length > 0) return tool.content.join("\n")
    return undefined
}

interface ApprovalSummary {
    title: string
    detail?: string
}

interface ApprovalCardProps extends ApprovalSummary {
    /** Render the detail in a monospace block, used for commands and structured payloads. */
    monospace?: boolean
    /** Text offered by the copy action; omitted when the card has nothing worth copying. */
    copyText?: string
    copyLabel?: string
}

/**
 * Titled approval card shared by every approval presentation.
 *
 * The card is width-bound to the chat column: long paths, URLs, and JSON wrap at
 * any character instead of widening the row, and very long bodies scroll inside
 * a bounded block so the approval buttons stay in view.
 */
function ApprovalCard({ title, detail, monospace = false, copyText, copyLabel }: ApprovalCardProps) {
    const { t } = useUiTranslation()
    return (
        <div
            className="relative mx-3.5 mb-2 min-w-0 max-w-full overflow-hidden rounded-sm border border-editor-group-border bg-code p-3"
            data-testid="tool-approval-summary">
            {copyText ? (
                <div className="absolute right-1 top-1">
                    <CopyButton ariaLabel={copyLabel ?? t("chatInput.common.copy")} textToCopy={copyText} />
                </div>
            ) : null}
            <div className={copyText ? "pr-8 font-semibold text-foreground" : "font-semibold text-foreground"}>{title}</div>
            {detail ? (
                <div
                    className={
                        monospace
                            ? "mt-1 max-h-60 overflow-y-auto whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-xs"
                            : "mt-1 max-h-60 overflow-y-auto whitespace-pre-wrap [overflow-wrap:anywhere] text-sm"
                    }>
                    {detail}
                </div>
            ) : null}
        </div>
    )
}

function parseObject(text: string | undefined): Record<string, unknown> | undefined {
    if (!text) return undefined
    try {
        const parsed = JSON.parse(text) as unknown
        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : undefined
    } catch {
        return undefined
    }
}

function stringField(payload: Record<string, unknown> | undefined, key: string): string | undefined {
    const value = payload?.[key]
    return typeof value === "string" && value.trim() ? value : undefined
}

function mcpSummary(
    payload: Record<string, unknown> | undefined,
    fallback: string | undefined,
    t: UiTranslator,
): ApprovalSummary {
    const serverName = stringField(payload, "serverName")
    if (!serverName) return { title: t("chatInput.approval.mcp"), detail: fallback }
    if (payload?.type === "access_mcp_resource") {
        return { title: t("chatInput.approval.mcpResource", { server: serverName }), detail: stringField(payload, "uri") }
    }
    const toolName = stringField(payload, "toolName")
    const args = stringField(payload, "arguments")
    return {
        title: t("chatInput.approval.mcpTool", { server: serverName }),
        detail: [toolName, args].filter(Boolean).join("\n") || undefined,
    }
}

function subagentSummary(
    payload: Record<string, unknown> | undefined,
    fallback: string | undefined,
    t: UiTranslator,
): ApprovalSummary {
    const prompts = Array.isArray(payload?.prompts)
        ? payload.prompts.filter((prompt): prompt is string => typeof prompt === "string")
        : []
    if (prompts.length === 0) return { title: t("chatInput.approval.subagents"), detail: fallback }
    return {
        title: t("chatInput.approval.subagentCount", { count: prompts.length }),
        detail: prompts.map((prompt, index) => `${index + 1}. ${prompt}`).join("\n"),
    }
}

/** Resolve the title and body for approvals whose payload is not a `UiSayTool`. */
function askApprovalSummary(message: UiMessage, t: UiTranslator): ApprovalSummary {
    const payload = parseObject(message.text)
    const fallback = message.text?.trim() ? message.text : undefined
    switch (message.ask) {
        case "use_mcp_server":
            return mcpSummary(payload, fallback, t)
        case "use_subagents":
            return subagentSummary(payload, fallback, t)
        case "spawn_task":
            return { title: t("chatInput.approval.newTask"), detail: stringField(payload, "task") ?? fallback }
        case "browser_action_launch":
            return { title: t("chatInput.approval.browser"), detail: stringField(payload, "url") ?? fallback }
        default:
            return { title: t("chatInput.approval.genericTool"), detail: fallback }
    }
}

/** Render approval-oriented interaction content from the exact persisted ask anchor. */
export function ApprovalRenderer(props: PresentationProps) {
    const { t } = useUiTranslation()
    const [imageExpanded, setImageExpanded] = useState(true)
    const imageGeneration = props.message.imageGeneration ?? parseImageGenerationToolText(props.message.text)
    if (imageGeneration) {
        return (
            <div className="mx-3.5 mb-2">
                <ImageGenerationRow
                    isExpanded={imageExpanded}
                    onToggleExpand={() => setImageExpanded((expanded) => !expanded)}
                    presentation={imageGeneration}
                />
            </div>
        )
    }
    const tool = parseTool(props.message.text)
    if (tool) {
        return (
            <ApprovalCard
                detail={toolDetail(tool, t)}
                title={t(TOOL_APPROVAL_TITLES[tool.tool] ?? "chatInput.approval.genericTool")}
            />
        )
    }
    const summary = askApprovalSummary(props.message, t)
    return <ApprovalCard {...summary} monospace={props.message.ask === "use_mcp_server"} />
}

/** Render command-oriented interaction content. */
export function CommandRenderer(props: PresentationProps) {
    const { t } = useUiTranslation()
    // The row's fields are the authority. Copying the command must not carry the
    // directory or an approval marker along with it, which is what reading `text`
    // alone would do for an older row.
    const row = readCommandRow(props.message)
    return (
        <ApprovalCard
            copyLabel={t("chatInput.approval.copyCommand")}
            copyText={row.command}
            detail={
                row.workingDirectory
                    ? t("chatInput.approval.commandDirectory", { command: row.command, directory: row.workingDirectory })
                    : row.command
            }
            monospace
            title={t("chatInput.approval.command")}
        />
    )
}

/** Render conversation interaction content. */
export function ConversationRenderer(props: PresentationProps) {
    return shell(props.message)
}

/** Render a pending New Task through the same presentation contract the handler writes. */
export function NewTaskRenderer(props: PresentationProps) {
    const newTask = parseNewTaskAsk(props.message.text)
    return <NewTaskPreview context={newTask.context ? [newTask.context] : undefined} task={newTask.task} />
}

/**
 * Render the pending GitHub issue draft with the user's supplement and consent choice.
 *
 * The preview is keyed by its anchor row so a later report starts from its own draft
 * instead of the supplement typed into the previous one.
 */
export function ReportBugRenderer(props: PresentationProps) {
    return (
        <ReportBugPreview
            data={props.message.text ?? ""}
            editable
            key={props.message.ts}
            onSelectionChange={props.onSelectionChange}
            selection={props.selection}
        />
    )
}

/** Render completion interaction content. */
export function CompletionRenderer(props: PresentationProps) {
    return shell(props.message)
}

/** Render API error interaction content. */
export function ErrorRenderer(props: PresentationProps) {
    return <ApiFailureContent error={props.message.text} testId="error-presentation-box" />
}

/** Render resume interaction content. */
export function ResumeRenderer(props: PresentationProps) {
    return shell(props.message)
}

/** Parse pending focus-chain item labels from the persisted plan payload. */
function focusItems(message: UiMessage): string[] {
    let plan = message.text ?? ""
    try {
        const parsed = JSON.parse(plan) as { plan?: string }
        plan = parsed.plan ?? plan
    } catch {
        // Plain-text plans are valid historical presentation payloads.
    }
    return plan
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => /^- \[ \]/.test(line))
        .map((line) => line.replace(/^- \[ \]\s*/, ""))
}

/** Render focus-chain checkboxes with host-owned selection state. */
export function FocusChainRenderer({ message, selection, onSelectionChange }: PresentationProps) {
    const items = focusItems(message)
    return (
        <div>
            {items.map((item, index) => {
                const value = String(index)
                return (
                    <label key={value}>
                        <input
                            aria-label={item}
                            checked={selection.includes(value)}
                            onChange={(event) => {
                                const next = event.target.checked
                                    ? [...selection, value]
                                    : selection.filter((selected) => selected !== value)
                                onSelectionChange(next)
                            }}
                            type="checkbox"
                        />
                        {item}
                    </label>
                )
            })}
        </div>
    )
}
