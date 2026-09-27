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

function JsonToolApproval({ tool }: { tool: ClineSayTool }) {
	const detail = toolDetail(tool)
	return (
		<div className="mx-3.5 mb-2 rounded-sm border border-editor-group-border bg-code p-3" data-testid="tool-approval-summary">
			<div className="font-semibold text-foreground">{TOOL_APPROVAL_TITLES[tool.tool]}</div>
			{detail ? <div className="mt-1 whitespace-pre-wrap break-words text-sm">{detail}</div> : null}
		</div>
	)
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
	return tool ? <JsonToolApproval tool={tool} /> : shell(props.message)
}

/** Render command-oriented interaction content. */
export function CommandRenderer(props: PresentationProps) {
	return (
		<div className="relative rounded-sm border border-editor-group-border bg-code p-3 pr-10">
			<div className="absolute right-1 top-1">
				<CopyButton ariaLabel="Copy command" textToCopy={props.message.text} />
			</div>
			<pre className="m-0 whitespace-pre-wrap break-words font-mono text-xs">{props.message.text}</pre>
		</div>
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
