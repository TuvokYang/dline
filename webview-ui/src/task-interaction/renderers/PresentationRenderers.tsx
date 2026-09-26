import type { ClineMessage, ClineSayTool } from "@shared/ExtensionMessage"
import { parseImageGenerationToolText } from "@shared/image-generation"
import { useState } from "react"
import { ApiErrorBox } from "@/components/chat/ApiErrorBox"
import ImageGenerationRow from "@/components/chat/ImageGenerationRow"
import { CopyButton } from "@/components/common/CopyButton"

/** Props shared by pure interaction presentation renderers. */
export interface PresentationProps {
	message: ClineMessage
	selection: string[]
	onSelectionChange: (selection: string[]) => void
}

/** Render one pure presentation shell. */
function shell(message: ClineMessage) {
	return <div>{message.text}</div>
}

const TOOL_APPROVAL_TITLES: Record<ClineSayTool["tool"], string> = {
	editedExistingFile: "Dline wants to edit this file:",
	newFileCreated: "Dline wants to create this file:",
	fileDeleted: "Dline wants to delete this file:",
	readFile: "Dline wants to read this file:",
	listFilesTopLevel: "Dline wants to list this directory:",
	listFilesRecursive: "Dline wants to recursively list this directory:",
	listCodeDefinitionNames: "Dline wants to inspect definitions in this directory:",
	searchFiles: "Dline wants to search project files:",
	webFetch: "Dline wants to fetch this URL:",
	webSearch: "Dline wants to search the web:",
	codeExecution: "Dline wants to run code in the sandbox:",
	summarizeTask: "Dline wants to summarize the task:",
	useSkill: "Dline wants to load this skill:",
	loadCapability: "Dline wants to load this capability:",
	findReferences: "Dline wants to find references for:",
	renameSymbol: "Dline wants to rename this symbol:",
	replaceText: "Dline wants to replace text in project files:",
	focusChainChanged: "Dline wants to update the focus chain:",
	statusUpdate: "Dline wants to post this status update:",
	actModeRespond: "Dline wants to continue execution with this update:",
	killCommand: "Dline wants to stop this command:",
	generateImage: "Dline wants to generate an image:",
}

function parseTool(text: string | undefined): ClineSayTool | undefined {
	if (!text) return undefined
	try {
		const parsed = JSON.parse(text) as unknown
		if (typeof parsed !== "object" || parsed === null || !("tool" in parsed) || typeof parsed.tool !== "string") {
			return undefined
		}
		return parsed as ClineSayTool
	} catch {
		return undefined
	}
}

function toolDetail(tool: ClineSayTool): string | undefined {
	if (tool.tool === "searchFiles" && tool.regex) {
		return `"${tool.regex}"${tool.path ? ` in ${tool.path}` : tool.filePattern ? ` in ${tool.filePattern}` : ""}`
	}
	if (tool.symbolName) return tool.symbolName
	if (tool.path) return tool.path
	if (tool.filePattern) return tool.filePattern
	if (typeof tool.content === "string" && tool.content.trim()) return tool.content
	if (Array.isArray(tool.content) && tool.content.length > 0) return tool.content.join("\n")
	return undefined
}

const GENERIC_APPROVAL_TITLE = "Dline wants your approval:"

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
	return (
		<div
			className="relative mx-3.5 mb-2 min-w-0 max-w-full overflow-hidden rounded-sm border border-editor-group-border bg-code p-3"
			data-testid="tool-approval-summary">
			{copyText ? (
				<div className="absolute right-1 top-1">
					<CopyButton ariaLabel={copyLabel ?? "Copy"} textToCopy={copyText} />
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

function mcpSummary(payload: Record<string, unknown> | undefined, fallback: string | undefined): ApprovalSummary {
	const serverName = stringField(payload, "serverName")
	if (!serverName) return { title: "Dline wants to use an MCP server:", detail: fallback }
	if (payload?.type === "access_mcp_resource") {
		return { title: `Dline wants to access a resource on the ${serverName} MCP server:`, detail: stringField(payload, "uri") }
	}
	const toolName = stringField(payload, "toolName")
	const args = stringField(payload, "arguments")
	return {
		title: `Dline wants to use a tool on the ${serverName} MCP server:`,
		detail: [toolName, args].filter(Boolean).join("\n") || undefined,
	}
}

function subagentSummary(payload: Record<string, unknown> | undefined, fallback: string | undefined): ApprovalSummary {
	const prompts = Array.isArray(payload?.prompts)
		? payload.prompts.filter((prompt): prompt is string => typeof prompt === "string")
		: []
	if (prompts.length === 0) return { title: "Dline wants to run subagents:", detail: fallback }
	return {
		title: prompts.length === 1 ? "Dline wants to run a subagent:" : `Dline wants to run ${prompts.length} subagents:`,
		detail: prompts.map((prompt, index) => `${index + 1}. ${prompt}`).join("\n"),
	}
}

/** Resolve the title and body for approvals whose payload is not a `ClineSayTool`. */
function askApprovalSummary(message: ClineMessage): ApprovalSummary {
	const payload = parseObject(message.text)
	const fallback = message.text?.trim() ? message.text : undefined
	switch (message.ask) {
		case "use_mcp_server":
			return mcpSummary(payload, fallback)
		case "use_subagents":
			return subagentSummary(payload, fallback)
		case "spawn_task":
			return { title: "Dline wants to start a new task:", detail: stringField(payload, "task") ?? fallback }
		case "browser_action_launch":
			return { title: "Dline wants to use the browser:", detail: stringField(payload, "url") ?? fallback }
		default:
			return { title: GENERIC_APPROVAL_TITLE, detail: fallback }
	}
}

/** Render approval-oriented interaction content from the exact persisted ask anchor. */
export function ApprovalRenderer(props: PresentationProps) {
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
		return <ApprovalCard detail={toolDetail(tool)} title={TOOL_APPROVAL_TITLES[tool.tool] ?? GENERIC_APPROVAL_TITLE} />
	}
	const summary = askApprovalSummary(props.message)
	return <ApprovalCard {...summary} monospace={props.message.ask === "use_mcp_server"} />
}

/** Render command-oriented interaction content. */
export function CommandRenderer(props: PresentationProps) {
	return (
		<ApprovalCard
			copyLabel="Copy command"
			copyText={props.message.text}
			detail={props.message.text}
			monospace
			title="Dline wants to execute this command:"
		/>
	)
}

/** Render conversation interaction content. */
export function ConversationRenderer(props: PresentationProps) {
	return shell(props.message)
}

/** Render report interaction content. */
export function ReportRenderer(props: PresentationProps) {
	return shell(props.message)
}

/** Render completion interaction content. */
export function CompletionRenderer(props: PresentationProps) {
	return shell(props.message)
}

/** Render API error interaction content. */
export function ErrorRenderer(props: PresentationProps) {
	return <ApiErrorBox error={props.message.text} testId="error-presentation-box" />
}

/** Render resume interaction content. */
export function ResumeRenderer(props: PresentationProps) {
	return shell(props.message)
}

/** Parse pending focus-chain item labels from the persisted plan payload. */
function focusItems(message: ClineMessage): string[] {
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
