import { UiMessage, UiSayTool } from "@shared/ExtensionMessage"
import { StringRequest } from "@shared/proto/dline/common"
import { memo, useCallback, useMemo, useState } from "react"
import { cleanPathPrefix } from "@/components/common/CodeAccordian"
import { cn } from "@/lib/utils"
import { FileServiceClient } from "@/services/grpc-client"
import { getIconByToolName, getToolsNotInCurrentActivities, isLowStakesTool } from "../../utils/messageUtils"
import { ToolItemRow } from "./ToolItemRow"
import type { ToolItemText, ToolRowParts } from "./tool-row-layout"

interface ToolGroupRendererProps {
	messages: UiMessage[]
	allMessages: UiMessage[]
	isLastGroup: boolean
}

interface ToolWithReasoning {
	tool: UiMessage
	parsedTool: UiSayTool
	reasoning?: string
	isActive?: boolean
	activityText?: ToolItemText
}

const EXPANDABLE_TOOLS = new Set([
	"listFilesTopLevel",
	"listFilesRecursive",
	"listCodeDefinitionNames",
	"searchFiles",
	"findReferences",
])

/** Search terms shown before collapsing the rest into "+N". */
const SEARCH_TERM_LIMIT = 3

/**
 * Split an alternation regex into readable terms.
 * Returns both the full list and a shortened form, so the row and its tooltip
 * stay derived from one source.
 */
export function formatSearchTerms(regex: string, limit = SEARCH_TERM_LIMIT): ToolItemText {
	const terms = regex
		.split("|")
		.map((term) => term.trim().replace(/\\b/g, "").replace(/\\s\?/g, " "))
		.filter(Boolean)

	const full = `"${terms.join(" | ")}"`
	const short = terms.length > limit ? `"${terms.slice(0, limit).join(" | ")} +${terms.length - limit}"` : full
	return { displayText: short, tooltipText: full }
}

/** Plural form for the units used in scale suffixes. */
const UNIT_PLURALS = { match: "matches", ref: "refs" } as const

/**
 * Build the "(N matches · M files)" suffix shown after a search or reference target.
 * An unknown count yields an empty suffix so the row never claims a wrong number;
 * a truncated result set marks the count as a lower bound.
 */
export function formatScale(
	count: number | undefined,
	files: number | undefined,
	unit: keyof typeof UNIT_PLURALS,
	truncated = false,
): string {
	if (count == null) {
		return ""
	}
	const amount = truncated ? `${count}+` : String(count)
	const unitLabel = count === 1 && !truncated ? unit : UNIT_PLURALS[unit]
	if (!files) {
		return ` (${amount} ${unitLabel})`
	}
	return ` (${amount} ${unitLabel} · ${files} file${files === 1 ? "" : "s"})`
}

/** Render a search as `"terms" in dir/ (pattern) (N matches · M files)`. */
export function formatSearchDisplay(tool: UiSayTool): ToolItemText & { row: ToolRowParts } {
	const terms = formatSearchTerms(tool.regex || "")
	const cleanedPath = cleanPathPrefix(tool.path || "")
	const pattern = tool.filePattern && tool.filePattern !== "*" ? ` (${tool.filePattern})` : ""
	const scale = formatScale(tool.count, tool.files, "match", tool.truncated)

	return {
		displayText: `${terms.displayText} in ${cleanedPath}/${pattern}${scale}`,
		tooltipText: `${terms.tooltipText} in ${cleanedPath}/${pattern}${scale}`,
		row: { prefix: terms.displayText, prefixSeparator: " in ", path: `${cleanedPath}/`, suffix: `${pattern}${scale}`.trim() },
	}
}

/**
 * Render a reference lookup as `"symbol" in file (N refs · M files)`.
 * Falls back to a generic target when the symbol could not be resolved, so the
 * row is never empty.
 */
export function formatReferencesDisplay(tool: UiSayTool): ToolItemText & { row: ToolRowParts } {
	const target = tool.symbolName ? `"${tool.symbolName}"` : "references"
	const cleanedPath = cleanPathPrefix(tool.path || "")
	const scale = formatScale(tool.count, tool.files, "ref")

	return {
		displayText: `${target} in ${cleanedPath}${scale}`,
		tooltipText: `${target} in ${cleanedPath}${scale}`,
		row: { prefix: target, prefixSeparator: " in ", path: cleanedPath, suffix: scale.trim() },
	}
}

/**
 * Text for a tool that is still running.
 * Shares the completed-state formatters so the same operation reads the same
 * way before and after it finishes.
 */
export function getActivityText(tool: UiSayTool): ToolItemText | null {
	const cleanedPath = cleanPathPrefix(tool.path || "")

	switch (tool.tool) {
		case "readFile": {
			if (!tool.path) {
				return null
			}
			const lineHint =
				tool.readLineStart != null && tool.readLineEnd != null ? ` (lines ${tool.readLineStart}-${tool.readLineEnd})` : ""
			return {
				displayText: `Reading ${cleanedPath}${lineHint}...`,
				tooltipText: `Reading ${cleanedPath}${lineHint}`,
				row: {
					prefix: "Reading",
					path: cleanedPath,
					suffix: lineHint ? `lines ${tool.readLineStart}-${tool.readLineEnd}` : "",
					suffixSeparator: " · ",
				},
			}
		}
		case "listFilesTopLevel":
		case "listFilesRecursive":
			return tool.path
				? {
						displayText: `Exploring ${cleanedPath}/...`,
						tooltipText: `Exploring ${cleanedPath}/`,
						row: { prefix: "Exploring", path: `${cleanedPath}/` },
					}
				: null
		case "searchFiles": {
			if (!tool.regex || !tool.path) {
				return null
			}
			const search = formatSearchDisplay(tool)
			return {
				displayText: `Searching ${search.displayText}...`,
				tooltipText: `Searching ${search.tooltipText}`,
				row: { ...search.row, prefix: `Searching ${search.row.prefix}` },
			}
		}
		case "findReferences": {
			if (!tool.path) return null
			const references = formatReferencesDisplay(tool)
			return {
				displayText: `Finding ${references.displayText}...`,
				tooltipText: `Finding ${references.tooltipText}`,
				row: { ...references.row, prefix: `Finding ${references.row.prefix}` },
			}
		}
		case "listCodeDefinitionNames":
			return tool.path
				? {
						displayText: `Analyzing ${cleanedPath}/...`,
						tooltipText: `Analyzing ${cleanedPath}/`,
						row: { prefix: "Analyzing", path: `${cleanedPath}/` },
					}
				: null
		default:
			return null
	}
}

// Calculate current activities (from RequestStartRow logic)
const getCurrentActivities = (allMessages: UiMessage[]): UiMessage[] => {
	// Find current api_req
	let currentApiReqIndex = -1
	for (let i = allMessages.length - 1; i >= 0; i--) {
		const msg = allMessages[i]
		if (msg.say === "api_req_started" && msg.text) {
			try {
				const info = JSON.parse(msg.text)
				const hasCost = info.cost != null
				if (!hasCost) {
					currentApiReqIndex = i
					break
				}
			} catch {
				// ignore
			}
		}
	}

	if (currentApiReqIndex === -1) {
		return []
	}

	// Collect tools AFTER the current api_req_started
	const activities: UiMessage[] = []
	for (let i = currentApiReqIndex + 1; i < allMessages.length; i++) {
		const msg = allMessages[i]
		// Only collect tools that are currently executing (ask === "tool")
		// Skip completed tools (say === "tool") - they should be in the completed list
		if (msg.say === "tool" || msg.ask !== "tool") {
			continue
		}
		if (isLowStakesTool(msg)) {
			activities.push(msg)
		}
	}

	return activities
}

/**
 * Renders a collapsible group of low-stakes tool calls.
 * Shows both completed tools AND currently active tools in a unified list (only for last group).
 */
export const ToolGroupRenderer = memo(({ messages, allMessages, isLastGroup }: ToolGroupRendererProps) => {
	const [expandedItems, setExpandedItems] = useState<Record<number, boolean>>({})

	// Filter out tools in the "current activities" range (being shown in loading state)
	const filteredMessages = useMemo(() => getToolsNotInCurrentActivities(messages, allMessages), [messages, allMessages])

	// Get current activities (active reading/exploring) - only for last group
	const currentActivities = useMemo(() => {
		if (!isLastGroup) {
			return []
		}
		return getCurrentActivities(allMessages)
	}, [allMessages, isLastGroup])

	// Build completed tool items
	const completedTools = useMemo(() => buildToolsWithReasoning(filteredMessages), [filteredMessages])

	// Build active tool items
	const activeTools = useMemo(() => {
		return currentActivities
			.map((msg) => {
				const parsedTool = parseToolSafe(msg.text)
				return {
					tool: msg,
					parsedTool,
					reasoning: undefined,
					isActive: true,
					activityText: getActivityText(parsedTool),
				}
			})
			.filter((item) => item.activityText)
	}, [currentActivities])

	// Merge: completed items first, then active items (active only added to last group)
	// Deduplicate - exclude completed items that match active items by path
	const allTools = useMemo(() => {
		// Get paths of active items
		const activePaths = new Set(activeTools.map((item) => item.parsedTool.path).filter(Boolean))

		// Filter out completed items that are also being actively read
		const dedupedCompleted = completedTools.filter((item) => !activePaths.has(item.parsedTool.path))

		return [...dedupedCompleted, ...activeTools]
	}, [completedTools, activeTools])

	const summary = getToolGroupSummaryFromParsedTools(completedTools.map((item) => item.parsedTool))

	const handleOpenFile = useCallback((filePath: string) => {
		FileServiceClient.openFileRelativePath(StringRequest.create({ value: filePath })).catch((err) =>
			console.error("Failed to open file:", err),
		)
	}, [])

	const handleItemToggle = useCallback((ts: number) => {
		setExpandedItems((prev) => ({ ...prev, [ts]: !prev[ts] }))
	}, [])

	// Don't render if no tools to show
	if (allTools.length === 0) {
		return null
	}

	return (
		<div className={cn("px-4 py-2 ml-1 text-description")}>
			{/* Header */}
			<div className="text-[13px] text-description font-semibold mb-1">{summary}:</div>

			{/* Content - unified list of completed + active tools */}
			<div className="min-w-0">
				{allTools.map(({ tool, parsedTool, isActive, activityText }) => {
					const info = getToolDisplayInfo(parsedTool)
					if (!info) {
						return null
					}

					const isExpandable = EXPANDABLE_TOOLS.has(parsedTool.tool)
					const isItemExpanded = expandedItems[tool.ts] ?? false
					const content = parsedTool.content || null

					if (isActive && activityText) {
						return <ToolItemRow icon={info.icon} isActive key={tool.ts} text={activityText} />
					}

					return (
						<div className="min-w-0" key={tool.ts}>
							<ToolItemRow
								ariaExpanded={isExpandable ? isItemExpanded : undefined}
								icon={info.icon}
								onActivate={() => {
									if (isExpandable) {
										handleItemToggle(tool.ts)
										return
									}
									const filePathWithLine =
										parsedTool.readLineStart != null ? `${info.path}:${parsedTool.readLineStart}` : info.path
									handleOpenFile(filePathWithLine)
								}}
								text={info}
							/>
							{/* Expanded content for matches/references/folders/search */}
							{isExpandable && isItemExpanded && (
								<ExpandedToolContent
									content={Array.isArray(content) ? content.join("\n") : content}
									onOpenFile={handleOpenFile}
									parsedTool={parsedTool}
								/>
							)}
						</div>
					)
				})}
			</div>
		</div>
	)
})

/**
 * Build tool items WITHOUT reasoning.
 * Reasoning should not be displayed in file lists - only file/folder content.
 */
export function buildToolsWithReasoning(messages: UiMessage[]): ToolWithReasoning[] {
	const result: ToolWithReasoning[] = []
	// An approved read owns one summary entry but produces two rows, and their
	// order is not guaranteed: the result row carries the timestamp of the tool
	// block while the approval row is anchored when the dialog is revealed.
	// Pairing therefore has to work in both directions, and each row may only be
	// consumed once so two genuine reads of the same path stay two files.
	const paired: boolean[] = []

	for (const msg of messages) {
		// Skip reasoning messages - they should not be in file lists
		if (msg.say === "reasoning") {
			continue
		}

		// Skip partial tool messages — only render completed tools.
		// Intermediate partial states (e.g. path="e" while streaming
		// "e:\workspace\...") produce stale entries that the dedup
		// logic below cannot clean up because paths don't match.
		if (msg.partial === true) {
			continue
		}

		if (isLowStakesTool(msg)) {
			const parsedTool = parseToolSafe(msg.text)
			const readPath = parsedTool.tool === "readFile" ? parsedTool.path : undefined

			if (readPath) {
				// The result row replaces the approval it belongs to, because it is the
				// row that carries the resolved path and line range.
				if (msg.say === "tool") {
					const askIndex = findUnpairedReadRow(result, paired, readPath, "ask")
					if (askIndex !== -1) {
						result[askIndex] = { tool: msg, parsedTool, reasoning: undefined }
						paired[askIndex] = true
						continue
					}
				} else if (msg.ask === "tool") {
					// The result already arrived, so this approval adds no new file.
					const resultIndex = findUnpairedReadRow(result, paired, readPath, "say")
					if (resultIndex !== -1) {
						paired[resultIndex] = true
						continue
					}
				}
			}

			result.push({
				tool: msg,
				parsedTool,
				reasoning: undefined, // Never show reasoning in file lists
			})
			paired.push(false)
		}
	}

	return result
}

/**
 * Find the most recent read row for `path` that has not been paired yet.
 * `kind` selects whether an approval row or a result row is wanted.
 */
function findUnpairedReadRow(tools: ToolWithReasoning[], paired: boolean[], path: string, kind: "ask" | "say"): number {
	for (let index = tools.length - 1; index >= 0; index -= 1) {
		if (paired[index]) continue
		const candidate = tools[index]
		if (candidate.parsedTool.tool !== "readFile" || candidate.parsedTool.path !== path) continue
		const matchesKind = kind === "ask" ? candidate.tool.ask === "tool" : candidate.tool.say === "tool"
		if (matchesKind) return index
	}
	return -1
}

/**
 * Safely parse tool JSON, returning empty tool on failure.
 */
function parseToolSafe(text: string | undefined): UiSayTool {
	try {
		return JSON.parse(text || "{}") as UiSayTool
	} catch {
		return {} as UiSayTool
	}
}

/** Everything a tool row needs: its icon, the path to open, and both text forms. */
export interface ToolDisplayInfo extends ToolItemText {
	icon: React.ComponentType<{ className?: string }>
	/** Target passed to the file-open handler; unrelated to what is displayed. */
	path: string
	label: string
}

/** Keep the original path available to the width-aware row and the full tooltip. */
function pathOnlyText(path: string): ToolItemText {
	const cleaned = cleanPathPrefix(path)
	return { displayText: cleaned, tooltipText: cleaned, row: { path: cleaned } }
}

/**
 * Describe one completed tool entry.
 * Every branch produces both text forms, so the row never has to decide how to
 * fall back when a formatter yields nothing.
 */
export function getToolDisplayInfo(tool: UiSayTool): ToolDisplayInfo | null {
	const icon = getIconByToolName(tool.tool)
	const filePath = tool.path || ""
	const folderPath = `${filePath}/`

	switch (tool.tool) {
		case "readFile": {
			const lineNote =
				tool.readLineStart != null && tool.readLineEnd != null ? ` · lines ${tool.readLineStart}-${tool.readLineEnd}` : ""
			const cleaned = cleanPathPrefix(filePath)
			return {
				icon,
				path: filePath,
				label: "read",
				displayText: `${cleaned}${lineNote}`,
				tooltipText: `${cleaned}${lineNote}`,
				row: {
					path: cleaned,
					suffix: lineNote ? `lines ${tool.readLineStart}-${tool.readLineEnd}` : "",
					suffixSeparator: " · ",
				},
			}
		}
		case "listFilesTopLevel":
			return { icon, path: folderPath, label: "listed", ...pathOnlyText(folderPath) }
		case "listFilesRecursive":
			return { icon, path: folderPath, label: "listed recursively", ...pathOnlyText(folderPath) }
		case "listCodeDefinitionNames":
			return { icon, path: folderPath, label: "definitions", ...pathOnlyText(folderPath) }
		case "searchFiles":
			return {
				icon,
				path: folderPath,
				label: `search: ${tool.regex}`,
				...formatSearchDisplay(tool),
			}
		case "findReferences":
			return {
				icon,
				path: filePath,
				label: "references",
				...formatReferencesDisplay(tool),
			}
		case "renameSymbol": {
			const newName = tool.regex
			const preview = tool.dryRun ? " (preview)" : ""
			const summary = newName ? ` → "${newName}"` : ""
			const change = `${tool.count ?? "?"} changes in ${tool.files ?? "?"} files${preview}${summary}`
			return {
				icon,
				path: filePath,
				label: "rename",
				displayText: change,
				tooltipText: `${cleanPathPrefix(filePath)}\n${change}`,
			}
		}
		case "replaceText": {
			const find = tool.regex
			const preview = tool.dryRun ? " (preview)" : ""
			const change = find
				? `"${find}" → (${tool.count ?? "?"} in ${tool.files ?? "?"} files)${preview}`
				: `${tool.count ?? "?"} changes in ${tool.files ?? "?"} files`
			return {
				icon,
				path: filePath,
				label: "replace",
				displayText: change,
				tooltipText: `${cleanPathPrefix(filePath)}\n${change}`,
			}
		}
		default:
			return null
	}
}

/**
 * Get summary label for a tool group - shows what's been added to context.
 */
export function getToolGroupSummaryFromParsedTools(tools: UiSayTool[]): string {
	const counts = { read: 0, list: 0, search: 0, def: 0, refs: 0 }

	for (const tool of tools) {
		switch (tool.tool) {
			case "readFile":
				counts.read++
				break
			case "listFilesTopLevel":
			case "listFilesRecursive":
				counts.list++
				break
			case "searchFiles":
				counts.search++
				break
			case "findReferences":
				counts.refs++
				break
			case "listCodeDefinitionNames":
				counts.def++
				break
		}
	}

	const parts: string[] = []
	const action = counts.read > 0 || counts.list > 0 ? " read " : " "

	if (counts.read > 0) {
		parts.push(`${counts.read} file${counts.read > 1 ? "s" : ""}`)
	}
	if (counts.list > 0) {
		parts.push(`${counts.list} folder${counts.list > 1 ? "s" : ""}`)
	}
	if (counts.def > 0) {
		parts.push(`${counts.def} definition${counts.def > 1 ? "s" : ""}`)
	}
	if (counts.search > 0) {
		parts.push(`performed ${counts.search} search${counts.search > 1 ? "es" : ""}`)
	}
	if (counts.refs > 0) {
		parts.push(`found ${counts.refs} reference${counts.refs > 1 ? "s" : ""}`)
	}

	return parts.length === 0 ? "Context" : `Dline${action}${parts.join(", ")}`
}

/** Props for the expanded content renderer. */
interface ExpandedToolContentProps {
	parsedTool: UiSayTool
	onOpenFile: (filePath: string) => void
	content: string | null
}

/** Renders structured expanded content for matches/references, falls back to plain text. */
function ExpandedToolContent({ parsedTool, onOpenFile, content }: ExpandedToolContentProps): React.ReactNode {
	const matches = (parsedTool as any).matches as any[] | undefined
	const references = (parsedTool as any).references as any[] | undefined
	const symbolName = (parsedTool as any).symbolName as string | undefined

	// matches: rename / replace_text — render diff lines with +/- highlighting
	if (matches && matches.length > 0) {
		return (
			<div className="ml-4 my-1 max-h-40 overflow-auto rounded-xs">
				{matches.map((m, mi) => {
					const lines = (m.diff as string).split("\n")
					return (
						<div className="mb-1" key={mi}>
							<div
								className="text-[11px] text-description opacity-60 cursor-pointer hover:underline ml-1"
								onClick={() => onOpenFile(`${m.file}:${m.line}`)}>
								{m.file} L{m.line}
							</div>
							{lines.map((line: string, li: number) => {
								const isOld = line.startsWith("- ")
								const isNew = line.startsWith("+ ")
								const display = line.substring(2)
								return (
									<div
										className={cn(
											"whitespace-pre-wrap break-all py-0.5 px-2 rounded-sm text-xs",
											isOld ? "bg-red-100/40 text-red-800 line-through" : "",
											isNew ? "bg-green-100/40 text-green-800 font-semibold" : "",
										)}
										key={li}>
										{display}
									</div>
								)
							})}
						</div>
					)
				})}
			</div>
		)
	}

	// references: find_references — render context lines with symbolName bold, clickable
	if (references && references.length > 0) {
		return (
			<div className="ml-4 my-1 max-h-40 overflow-auto rounded-xs">
				{references.map((r, ri) => {
					const ctx = (r.context as string) || ""
					return (
						<div
							className="flex flex-col items-stretch gap-0.5 py-1 px-1 rounded-sm text-xs cursor-pointer hover:bg-accent/30"
							key={ri}
							onClick={() => onOpenFile(`${r.file}:${r.line}`)}>
							<span className="block w-full break-all text-description opacity-50" title={r.file}>
								{r.file} L{r.line}
							</span>
							<span className="block w-full min-w-0 whitespace-pre-wrap break-words font-mono">
								{renderHighlightedContext(ctx, symbolName)}
							</span>
						</div>
					)
				})}
			</div>
		)
	}

	// Fallback: plain text content
	if (content) {
		return (
			<pre className="m-1 ml-4 text-xs opacity-80 whitespace-pre-wrap break-words p-2 max-h-40 overflow-auto rounded-xs">
				{content}
			</pre>
		)
	}

	return null
}

/**
 * Render a context line with symbolName occurrences bolded.
 * Handles partial matches by splitting on the symbol name.
 */
function renderHighlightedContext(contextLine: string, symbolName?: string): React.ReactNode {
	if (!symbolName) return contextLine
	const parts = contextLine.split(new RegExp(`(${escapeRegex(symbolName)})`, "g"))
	return parts.map((part, i) =>
		part === symbolName ? (
			<span className="font-bold text-foreground" key={i}>
				{part}
			</span>
		) : (
			<span key={i}>{part}</span>
		),
	)
}

/** Escape special regex characters in a string. */
function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
