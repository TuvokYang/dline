import { COMMAND_OUTPUT_STRING } from "@shared/combineCommandSequences"
import {
	ClineApiReqInfo,
	ClineAskQuestion,
	ClineAskSpawnTask,
	ClineAskUseMcpServer,
	ClineMakePlanResponse,
	ClineMessage,
	ClineSayGenerateExplanation,
	ClineSayTool,
	COMPLETION_RESULT_CHANGES_FLAG,
} from "@shared/ExtensionMessage"
import { parseImageGenerationPresentation } from "@shared/image-generation"
import type { LoadCapabilityPayload } from "@shared/load-capabilities"
import { BooleanRequest, StringRequest } from "@shared/proto/dline/common"
import { Mode } from "@shared/storage/types"
import deepEqual from "fast-deep-equal"
import {
	ArrowRightIcon,
	BellIcon,
	CheckIcon,
	ChevronDownIcon,
	ChevronRightIcon,
	CircleSlashIcon,
	CircleXIcon,
	FileCode2Icon,
	FilePlus2Icon,
	FoldVerticalIcon,
	ImageUpIcon,
	LightbulbIcon,
	LoaderCircleIcon,
	RefreshCwIcon,
	SettingsIcon,
	SquareArrowOutUpRightIcon,
	TriangleAlertIcon,
} from "lucide-react"
import { MouseEvent, memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useSize } from "react-use"
import { OptionsButtons } from "@/components/chat/OptionsButtons"
import { CheckmarkControl } from "@/components/common/CheckmarkControl"
import { WithCopyButton } from "@/components/common/CopyButton"
import McpResponseDisplay from "@/components/mcp/chat-display/McpResponseDisplay"
import McpResourceRow from "@/components/mcp/configuration/tabs/installed/server-row/McpResourceRow"
import McpToolRow from "@/components/mcp/configuration/tabs/installed/server-row/McpToolRow"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import { FileServiceClient, UiServiceClient } from "@/services/grpc-client"
import { findMatchingResourceOrTemplate, getMcpServerDisplayName } from "@/utils/mcp"
import CodeAccordian, { cleanPathPrefix } from "../common/CodeAccordian"
import ActModeRespondRow from "./ActModeRespondRow"
import { ApiErrorBox } from "./ApiErrorBox"
import { cancelTaskActivities } from "./activity/useTaskActivities"
import CodeExecutionRow from "./CodeExecutionRow"
import { CommandOutputContent, CommandOutputRow } from "./CommandOutputRow"
import { CompletionOutputRow } from "./CompletionOutputRow"
import { resolveApiErrorMessage } from "./chat-view/utils/messageUtils"
import { TOOL_RESPONSE_SCROLL_CLASS } from "./constants"
import { DiffEditRow } from "./DiffEditRow"
import { EditResultRow } from "./EditResultRow"
import ErrorRow from "./ErrorRow"
import { FeatureTip } from "./FeatureTip"
import { FocusChainChangeRow } from "./FocusChainChangeRow"
import GenerateReportRow from "./GenerateReportRow"
import HookMessage from "./HookMessage"
import ImageGenerationRow from "./ImageGenerationRow"
import { KillCommandRow } from "./KillCommandRow"
import LoadCapabilityRow from "./LoadCapabilityRow"
import { MarkdownRow } from "./MarkdownRow"
import NewTaskPreview from "./NewTaskPreview"
import PlanCompletionOutputRow from "./PlanCompletionOutputRow"
import QnaOutputRow from "./QnaOutputRow"
import QuoteButton from "./QuoteButton"
import ReportBugPreview from "./ReportBugPreview"
import { RequestStartRow } from "./RequestStartRow"
import SearchResultsDisplay from "./SearchResultsDisplay"
import StatusUpdateRow from "./StatusUpdateRow"
import SubagentStatusRow from "./SubagentStatusRow"
import { SummaryScrollContainer } from "./SummaryScrollContainer"
import { ThinkingRow } from "./ThinkingRow"
import UserMessage from "./UserMessage"
import WebFetchRow from "./WebFetchRow"
import WebSearchRow from "./WebSearchRow"

const HEADER_CLASSNAMES = "flex items-center gap-2.5 mb-3"

/**
 * Read the workspace-change verdict and display text of a completion message.
 *
 * Current messages carry the verdict in `completionHasChanges`. Tasks recorded
 * before that field existed appended a marker to the text instead, so the
 * marker is still accepted and stripped to keep old histories rendering their
 * change actions with the same text.
 */
function readCompletionChanges(message: ClineMessage): { hasChanges: boolean; text: string } {
	const rawText = message.text ?? ""
	const hasLegacyFlag = rawText.endsWith(COMPLETION_RESULT_CHANGES_FLAG)
	return {
		hasChanges: message.completionHasChanges === true || hasLegacyFlag,
		text: hasLegacyFlag ? rawText.slice(0, -COMPLETION_RESULT_CHANGES_FLAG.length) : rawText,
	}
}

// Module-level cache for command collapse state — survives virtual list row recycling
const commandCollapsedCache = new Map<number, boolean>()
// Track which commands have been auto-collapsed (completed -> collapsed once)
const autoCollapsedCommands = new Set<number>()

interface ChatRowProps {
	message: ClineMessage
	isExpanded: boolean
	onToggleExpand: (ts: number) => void
	lastModifiedMessage?: ClineMessage
	isLast: boolean
	onHeightChange: (isTaller: boolean) => void
	onFollowupOptionSelect?: (message: ClineMessage, option: string) => Promise<void>
	sendMessageFromChatRow?: (text: string, images: string[], files: string[]) => void
	onAddToInput?: (text: string) => void
	onSetQuote: (text: string) => void
	onCancelCommand?: () => void
	mode?: Mode
	reasoningContent?: string
	responseStarted?: boolean
	isRequestInProgress?: boolean
}

export interface QuoteButtonState {
	visible: boolean
	top: number
	left: number
	selectedText: string
}

interface ChatRowContentProps extends Omit<ChatRowProps, "onHeightChange"> {}

export const ProgressIndicator = () => <LoaderCircleIcon className="size-2 mr-2 animate-spin" />
const InvisibleSpacer = () => <div aria-hidden className="h-px" />

interface AutoRetryInfo {
	attempt?: number
	maxAttempts?: number
	delaySeconds?: number
	failed?: boolean
	errorMessage?: string
}

function AutoRetryErrorBox({ info, startedAt }: { info: AutoRetryInfo; startedAt: number }) {
	const delayMs = Math.max(0, Number(info.delaySeconds ?? 0) * 1000)
	const [remainingMs, setRemainingMs] = useState(() => Math.max(0, startedAt + delayMs - Date.now()))

	useEffect(() => {
		const deadline = startedAt + delayMs
		const updateRemaining = () => setRemainingMs(Math.max(0, deadline - Date.now()))
		updateRemaining()
		if (info.failed || delayMs <= 0) return
		const timer = setInterval(updateRemaining, 100)
		return () => clearInterval(timer)
	}, [delayMs, info.failed, startedAt])

	const remainingSeconds = Math.ceil(remainingMs / 1000)
	const isFailed = info.failed === true
	const isRetrying = !isFailed && remainingMs <= 0

	return (
		<ApiErrorBox error={info.errorMessage} testId="error-retry-box">
			<div className="flex items-start gap-2 text-xs">
				<RefreshCwIcon className={cn("mt-0.5 size-3 shrink-0 text-link", !isFailed && "animate-spin")} />
				<div className="min-w-0 flex-1">
					<div className="font-medium text-foreground">
						{isFailed
							? "Automatic retry stopped"
							: isRetrying
								? "Automatic retry in progress"
								: "Automatic retry scheduled"}
					</div>
					<div className="mt-1 text-description" data-testid="error-retry-countdown">
						{isFailed ? (
							<span>All {info.maxAttempts} automatic attempts were used.</span>
						) : (
							<div className="flex flex-wrap gap-x-3 gap-y-1">
								<span>
									Attempt <strong>{info.attempt}</strong> of <strong>{info.maxAttempts}</strong>
								</span>{" "}
								<span>
									{isRetrying ? (
										"Retrying now"
									) : (
										<>
											Next retry in <strong>{remainingSeconds}s</strong>
										</>
									)}
								</span>
							</div>
						)}
					</div>
				</div>
			</div>
		</ApiErrorBox>
	)
}

const ChatRow = memo(
	(props: ChatRowProps) => {
		const { isLast, onHeightChange } = props
		// Store the previous height to compare with the current height
		// This allows us to detect changes without causing re-renders
		const prevHeightRef = useRef(0)

		const [chatrow, { height }] = useSize(
			<div className="relative pt-2.5 px-4">
				<ChatRowContent {...props} />
			</div>,
		)

		useEffect(() => {
			// used for partials command output etc.
			// NOTE: it's important we don't distinguish between partial or complete here since our scroll effects in chatview need to handle height change during partial -> complete
			const isInitialRender = prevHeightRef.current === 0 // prevents scrolling when new element is added since we already scroll for that
			// height starts off at Infinity
			if (isLast && height !== 0 && height !== Number.POSITIVE_INFINITY && height !== prevHeightRef.current) {
				if (!isInitialRender) {
					onHeightChange(height > prevHeightRef.current)
				}
				prevHeightRef.current = height
			}
		}, [height, isLast, onHeightChange])

		// we cannot return null as virtuoso does not support it so we use a separate visibleMessages array to filter out messages that should not be rendered
		return chatrow
	},
	// memo does shallow comparison of props, so we need to do deep comparison of arrays/objects whose properties might change
	deepEqual,
)

export default ChatRow

export const ChatRowContent = memo(
	({
		message,
		isExpanded,
		onToggleExpand,
		lastModifiedMessage,
		isLast,
		onFollowupOptionSelect,
		sendMessageFromChatRow,
		onAddToInput,
		onSetQuote,
		onCancelCommand,
		mode,
		reasoningContent,
		responseStarted,
	}: ChatRowContentProps) => {
		const {
			backgroundEditEnabled,
			mcpServers,
			mcpMarketplaceCatalog,
			onRelinquishControl,
			vscodeTerminalExecutionMode,
			clineMessages,
			checkpointManagerErrorMessage,
			showFeatureTips,
			taskViewState,
			currentTaskItem,
		} = useExtensionState()
		const [seeNewChangesDisabled, setSeeNewChangesDisabled] = useState(false)
		const [explainChangesDisabled, setExplainChangesDisabled] = useState(false)
		const [quoteButtonState, setQuoteButtonState] = useState<QuoteButtonState>({
			visible: false,
			top: 0,
			left: 0,
			selectedText: "",
		})
		const contentRef = useRef<HTMLDivElement>(null)

		// Command output expansion state (for all messages, but only used by command messages)
		const [isOutputFullyExpanded, setIsOutputFullyExpanded] = useState(false)
		const prevCommandExecutingRef = useRef<boolean>(false)

		const hasAutoExpandedRef = useRef(false)
		const hasAutoCollapsedRef = useRef(false)
		const prevIsLastRef = useRef(isLast)

		// Auto-expand completion output when it's the last message (runs once per message)
		useEffect(() => {
			const isCompletionResult = message.ask === "completion_result" || message.say === "completion_result"

			if (isLast && isCompletionResult && !hasAutoExpandedRef.current) {
				hasAutoExpandedRef.current = true
			}
		}, [isLast, message.ask, message.say])

		const [cost, _apiReqCancelReason, apiReqStreamingFailedMessage, , usageInfo] = useMemo(() => {
			if (message.text != null && message.say === "api_req_started") {
				const info: ClineApiReqInfo = JSON.parse(message.text)
				return [
					info.cost,
					info.cancelReason,
					info.streamingFailedMessage,
					info.retryStatus,
					{
						tokensIn: info.tokensIn,
						tokensOut: info.tokensOut,
						cacheWrites: info.cacheWrites,
						cacheReads: info.cacheReads,
						cacheHitRate: info.cacheHitRate,
						currency: info.currency,
						inputPrice: info.inputPrice,
						outputPrice: info.outputPrice,
					},
				]
			}
			return [undefined, undefined, undefined, undefined, undefined]
		}, [message.text, message.say])

		const apiRequestFailedMessage = resolveApiErrorMessage({
			isLast,
			lastModifiedMessage,
			streamingFailedMessage: apiReqStreamingFailedMessage,
			taskViewState,
		})

		const type = message.type === "ask" ? message.ask : message.say

		const isCommandMessage = type === "command"
		// Check if command has output to determine if it's actually executing
		const _commandHasOutput = message.text?.includes(COMMAND_OUTPUT_STRING) ?? false
		// Use commandStatus to determine state; legacy messages without commandStatus are treated as completed
		const isCommandExecuting = isCommandMessage && message.commandStatus === "running"
		const isCommandPending = isCommandMessage && message.commandStatus === "pending"
		const isCommandSkipped = isCommandMessage && message.commandStatus === "skipped"
		const isCommandFailed = isCommandMessage && message.commandStatus === "failed"
		const isCommandCancelled = isCommandMessage && message.commandStatus === "cancelled"
		const isCommandInterrupted = isCommandMessage && message.commandStatus === "interrupted"
		const isCommandCompleted =
			isCommandMessage &&
			(message.commandStatus === "completed" || message.commandStatus === undefined) &&
			!isCommandSkipped

		const cancelCommand =
			onCancelCommand ??
			(message.activityId && currentTaskItem?.id
				? () => void cancelTaskActivities(currentTaskItem.id, [message.activityId as string])
				: undefined)

		const isMcpServerResponding = isLast && lastModifiedMessage?.say === "mcp_server_request_started"

		const handleToggle = useCallback(() => {
			onToggleExpand(message.ts)
		}, [onToggleExpand, message.ts])

		// Use the onRelinquishControl hook instead of message event
		useEffect(() => {
			return onRelinquishControl(() => {
				setSeeNewChangesDisabled(false)
				setExplainChangesDisabled(false)
			})
		}, [onRelinquishControl])

		// --- Quote Button Logic ---
		// MOVE handleQuoteClick INSIDE ChatRowContent
		const handleQuoteClick = useCallback(() => {
			onSetQuote(quoteButtonState.selectedText)
			window.getSelection()?.removeAllRanges() // Clear the browser selection
			setQuoteButtonState({ visible: false, top: 0, left: 0, selectedText: "" })
		}, [onSetQuote, quoteButtonState.selectedText]) // <-- Use onSetQuote from props

		const handleMouseUp = useCallback((event: MouseEvent<HTMLDivElement>) => {
			// Get the target element immediately, before the timeout
			const targetElement = event.target as Element
			const isClickOnButton = !!targetElement.closest(".quote-button-class")

			// Delay the selection check slightly
			setTimeout(() => {
				// Now, check the selection state *after* the browser has likely updated it
				const selection = window.getSelection()
				const selectedText = selection?.toString().trim() ?? ""

				let shouldShowButton = false
				let buttonTop = 0
				let buttonLeft = 0
				let textToQuote = ""

				// Condition 1: Check if there's a valid, non-collapsed selection within bounds
				// Ensure contentRef.current still exists in case component unmounted during timeout
				if (selectedText && contentRef.current && selection && selection.rangeCount > 0 && !selection.isCollapsed) {
					const range = selection.getRangeAt(0)
					const rangeRect = range.getBoundingClientRect()
					// Re-check ref inside timeout and ensure containerRect is valid
					const containerRect = contentRef.current?.getBoundingClientRect()

					if (containerRect) {
						// Check if containerRect was successfully obtained
						const tolerance = 5 // Allow for a small pixel overflow (e.g., for margins)
						const isSelectionWithin =
							rangeRect.top >= containerRect.top &&
							rangeRect.left >= containerRect.left &&
							rangeRect.bottom <= containerRect.bottom + tolerance && // Added tolerance
							rangeRect.right <= containerRect.right

						if (isSelectionWithin) {
							shouldShowButton = true // Mark that we should show the button
							const buttonHeight = 30
							// Calculate the raw top position relative to the container, placing it above the selection
							const calculatedTop = rangeRect.top - containerRect.top - buttonHeight - 5 // Subtract button height and a small margin
							// Allow the button to potentially have a negative top value
							buttonTop = calculatedTop
							buttonLeft = Math.max(0, rangeRect.left - containerRect.left) // Still prevent going left of container
							textToQuote = selectedText
						}
					}
				}

				// Decision: Set the state based on whether we should show or hide
				if (shouldShowButton) {
					// Scenario A: Valid selection exists -> Show button
					setQuoteButtonState({
						visible: true,
						top: buttonTop,
						left: buttonLeft,
						selectedText: textToQuote,
					})
				} else if (!isClickOnButton) {
					// Scenario B: No valid selection AND click was NOT on button -> Hide button
					setQuoteButtonState({ visible: false, top: 0, left: 0, selectedText: "" })
				}
				// Scenario C (Click WAS on button): Do nothing here, handleQuoteClick takes over.
			}, 0) // Delay of 0ms pushes execution after current event cycle
		}, []) // Dependencies remain empty

		const [icon, title] = useMemo(() => {
			switch (type) {
				case "error":
					return [
						<span className="codicon codicon-error text-error mb-[-1.5px]" />,
						<span className="text-error font-bold">Error</span>,
					]
				case "mistake_limit_reached":
					return [
						<CircleXIcon className="text-error size-2" />,
						<span className="text-error font-bold">Dline is having trouble...</span>,
					]
				case "command":
					return [null, null]
				case "use_mcp_server":
					const mcpServerUse = JSON.parse(message.text || "{}") as ClineAskUseMcpServer
					return [
						isMcpServerResponding ? (
							<ProgressIndicator />
						) : (
							<span className="codicon codicon-server text-foreground mb-[-1.5px]" />
						),
						<span className="ph-no-capture font-bold text-foreground break-words">
							Dline wants to {mcpServerUse.type === "use_mcp_tool" ? "use a tool" : "access a resource"} on the{" "}
							<code className="break-all">
								{getMcpServerDisplayName(mcpServerUse.serverName, mcpMarketplaceCatalog)}
							</code>{" "}
							MCP server:
						</span>,
					]
				case "completion_result":
					return [
						<span className="codicon codicon-check text-success mb-[-1.5px]" />,
						<span className="text-success font-bold">Task Completed</span>,
					]
				case "api_req_started":
					// API request rows no longer render the request payload/cost accordion.
					// Thinking/reasoning is handled directly in the api_req_started renderer below.
					return [null, null]
				case "followup":
					return [
						<span className="codicon codicon-question text-foreground mb-[-1.5px]" />,
						<span className="font-bold text-foreground">Dline has a question:</span>,
					]
				default:
					return [null, null]
			}
		}, [type, isMcpServerResponding, message.text, mcpMarketplaceCatalog])

		const tool = useMemo(() => {
			if (message.ask === "tool" || message.say === "tool") {
				return JSON.parse(message.text || "{}") as ClineSayTool
			}
			return null
		}, [message.ask, message.say, message.text])

		const isAutoCollapsibleMessage =
			message.ask === "completion_result" ||
			message.say === "completion_result" ||
			message.ask === "change_todo_list" ||
			tool?.tool === "summarizeTask" ||
			tool?.tool === "focusChainChanged"

		// Collapse expandable summaries and focus changes once when newer output arrives.
		// The parent owns expandedRows, so a manual reopen remains respected.
		useEffect(() => {
			const wasLast = prevIsLastRef.current
			if (wasLast && !isLast && isExpanded && isAutoCollapsibleMessage && !hasAutoCollapsedRef.current) {
				hasAutoCollapsedRef.current = true
				onToggleExpand(message.ts)
			}
			prevIsLastRef.current = isLast
		}, [isAutoCollapsibleMessage, isExpanded, isLast, message.ts, onToggleExpand])

		const conditionalRulesInfo = useMemo(() => {
			if (message.say !== "conditional_rules_applied" || !message.text) return null
			try {
				const parsed: unknown = JSON.parse(message.text)
				if (typeof parsed !== "object" || parsed === null) {
					return null
				}
				const { rules } = parsed as { rules?: unknown }
				if (!Array.isArray(rules)) {
					return null
				}
				return parsed as {
					rules: Array<{ name: string; matchedConditions: Record<string, string[]> }>
				}
			} catch {
				return null
			}
		}, [message.say, message.text])

		// Helper function to check if file is an image
		const isImageFile = (filePath: string): boolean => {
			const imageExtensions = [".png", ".jpg", ".jpeg", ".webp"]
			const extension = filePath.toLowerCase().split(".").pop()
			return extension ? imageExtensions.includes(`.${extension}`) : false
		}

		// Reset output expansion state when command stops (completes or is cancelled)
		useEffect(() => {
			if (isCommandMessage && prevCommandExecutingRef.current && !isCommandExecuting) {
				setIsOutputFullyExpanded(false)
			}
			prevCommandExecutingRef.current = isCommandExecuting
		}, [isCommandMessage, isCommandExecuting])

		// Auto-collapse when command completes (once per command)
		useEffect(() => {
			// A command row is streamed before it has any status, and a missing
			// status reads as "completed" so legacy rows still collapse. Those two
			// rules meet on a partial row, which would collapse the command before
			// it ever ran and latch that choice for the rest of its life, hiding
			// every later state behind the one-line summary. Only a settled row
			// can be finished.
			if (isCommandMessage && !message.partial && isCommandCompleted && !autoCollapsedCommands.has(message.ts)) {
				autoCollapsedCommands.add(message.ts)
				commandCollapsedCache.set(message.ts, true)
				// Force re-render to pick up the collapsed state
				setCommandCollapseTick((t) => t + 1)
			}
		}, [isCommandMessage, message.partial, isCommandCompleted, message.ts])

		// Auto-expand when command starts executing (only if running > 500ms)
		useEffect(() => {
			if (isCommandMessage && isCommandExecuting && !isExpanded) {
				const timer = setTimeout(() => {
					onToggleExpand(message.ts)
				}, 500)
				return () => clearTimeout(timer)
			}
		}, [isCommandMessage, isCommandExecuting, isExpanded, onToggleExpand, message.ts])

		// Derive collapsed state from module-level cache (survives virtual list recycling)
		const [, setCommandCollapseTick] = useState(0)
		const isCommandCollapsed = isCommandMessage ? (commandCollapsedCache.get(message.ts) ?? false) : false
		const toggleCommandCollapsed = useCallback(() => {
			if (!isCommandMessage) return
			const next = !commandCollapsedCache.get(message.ts)
			commandCollapsedCache.set(message.ts, next)
			setCommandCollapseTick((t) => t + 1)
		}, [isCommandMessage, message.ts])

		if (conditionalRulesInfo) {
			const names = conditionalRulesInfo.rules.map((r: { name: string }) => r.name).join(", ")
			return (
				<div className={HEADER_CLASSNAMES}>
					<span style={{ fontWeight: "bold" }}>Conditional rules applied:</span>
					<span className="ph-no-capture break-words whitespace-pre-wrap">{names}</span>
				</div>
			)
		}

		if (tool) {
			const colorMap = {
				red: "var(--vscode-errorForeground)",
				yellow: "var(--vscode-editorWarning-foreground)",
				green: "var(--vscode-charts-green)",
			}
			const toolIcon = (name: string, color?: string, rotation?: number, title?: string) => (
				<span
					className={`codicon codicon-${name} ph-no-capture`}
					style={{
						color: color ? colorMap[color as keyof typeof colorMap] || color : "var(--vscode-foreground)",
						marginBottom: "-1.5px",
						transform: rotation ? `rotate(${rotation}deg)` : undefined,
					}}
					title={title}
				/>
			)

			switch (tool.tool) {
				case "editedExistingFile":
					return (
						<>
							{backgroundEditEnabled && tool.path && tool.content ? (
								<DiffEditRow
									blockErrors={tool.blockErrors}
									fileAction="Update"
									isLoading={message.partial}
									patch={tool.content}
									path={tool.path}
									startLineNumbers={tool.startLineNumbers}
								/>
							) : (
								<CodeAccordian
									code={Array.isArray(tool.content) ? tool.content.join("\n\n") : tool.content}
									isExpanded={isExpanded}
									onToggleExpand={handleToggle}
									path={tool.path ?? ""}
								/>
							)}
						</>
					)
				case "fileDeleted":
					return (
						<CodeAccordian
							code={Array.isArray(tool.content) ? tool.content.join("\n\n") : tool.content}
							isExpanded={isExpanded}
							onToggleExpand={handleToggle}
							path={tool.path ?? ""}
						/>
					)
				case "newFileCreated":
					return (
						<>
							{backgroundEditEnabled && tool.path && tool.content ? (
								<DiffEditRow
									blockErrors={tool.blockErrors}
									fileAction="Add"
									isLoading={message.partial}
									patch={tool.content}
									path={tool.path}
									startLineNumbers={tool.startLineNumbers}
								/>
							) : (
								<CodeAccordian
									code={Array.isArray(tool.content) ? tool.content.join("\n\n") : (tool.content ?? "")}
									isExpanded={isExpanded}
									isLoading={message.partial}
									onToggleExpand={handleToggle}
									path={tool.path ?? ""}
								/>
							)}
						</>
					)
				case "readFile":
					const isImage = isImageFile(tool.path || "")
					// Shared by both renderings below so the clickable and inert
					// variants cannot drift apart in how the path is displayed.
					const readFilePathContent = (
						<>
							{tool.path?.startsWith(".") && <span>.</span>}
							{tool.path && !tool.path.startsWith(".") && !tool.path.match(/^[a-zA-Z]:/) && <span>/</span>}
							<span className="ph-no-capture whitespace-nowrap overflow-hidden text-ellipsis mr-2 text-left [direction: rtl]">
								{`${cleanPathPrefix(tool.path ?? "")}\u200E`}
								{tool.readLineStart != null && tool.readLineEnd != null ? (
									<span className="opacity-80">
										{" "}
										({tool.readLineStart}-{tool.readLineEnd})
									</span>
								) : null}
							</span>
							<div className="grow" />
						</>
					)
					return (
						<div>
							<div className={HEADER_CLASSNAMES}>
								{isImage ? <ImageUpIcon className="size-2" /> : <FileCode2Icon className="size-2" />}
								{tool.operationIsLocatedInWorkspace === false &&
									toolIcon("sign-out", "yellow", -90, "This file is outside of your workspace")}
								<span className="font-bold">Dline wants to read this file:</span>
							</div>
							<div className="bg-code rounded-sm overflow-hidden border border-editor-group-border">
								{/* Only a non-image path opens an editor, so only that case is
								    rendered as a button. An image row stays inert text instead of
								    a control that announces an action it never performs. */}
								{isImage ? (
									<div className="text-description flex items-center select-text py-2 px-2.5">
										{readFilePathContent}
									</div>
								) : (
									<button
										className="text-description flex items-center w-full bg-transparent border-0 cursor-pointer select-none py-2 px-2.5 text-inherit font-inherit"
										onClick={() => {
											const filePathWithLine =
												tool.readLineStart != null ? `${tool.path}:${tool.readLineStart}` : tool.path
											FileServiceClient.openFileRelativePath(
												StringRequest.create({ value: filePathWithLine }),
											).catch((err) => console.error("Failed to open file:", err))
										}}
										type="button">
										{readFilePathContent}
										<SquareArrowOutUpRightIcon className="size-2" />
									</button>
								)}
							</div>
						</div>
					)
				case "listFilesTopLevel":
					return (
						<div>
							<div className={HEADER_CLASSNAMES}>
								{toolIcon("folder-opened")}
								{tool.operationIsLocatedInWorkspace === false &&
									toolIcon("sign-out", "yellow", -90, "This is outside of your workspace")}
								<span style={{ fontWeight: "bold" }}>
									{message.type === "ask"
										? "Dline wants to view the top level files in this directory:"
										: "Dline viewed the top level files in this directory:"}
								</span>
							</div>
							<CodeAccordian
								code={Array.isArray(tool.content) ? tool.content.join("\n") : (tool.content ?? "")}
								isExpanded={isExpanded}
								language="shell-session"
								onToggleExpand={handleToggle}
								path={tool.path ?? ""}
							/>
						</div>
					)
				case "listFilesRecursive":
					return (
						<div>
							<div className={HEADER_CLASSNAMES}>
								{toolIcon("folder-opened")}
								{tool.operationIsLocatedInWorkspace === false &&
									toolIcon("sign-out", "yellow", -90, "This is outside of your workspace")}
								<span style={{ fontWeight: "bold" }}>
									{message.type === "ask"
										? "Dline wants to recursively view all files in this directory:"
										: "Dline recursively viewed all files in this directory:"}
								</span>
							</div>
							<CodeAccordian
								code={Array.isArray(tool.content) ? tool.content.join("\n") : (tool.content ?? "")}
								isExpanded={isExpanded}
								language="shell-session"
								onToggleExpand={handleToggle}
								path={tool.path ?? ""}
							/>
						</div>
					)
				case "listCodeDefinitionNames":
					return (
						<div>
							<div className={HEADER_CLASSNAMES}>
								{toolIcon("file-code")}
								{tool.operationIsLocatedInWorkspace === false &&
									toolIcon("sign-out", "yellow", -90, "This file is outside of your workspace")}
								<span style={{ fontWeight: "bold" }}>
									{message.type === "ask"
										? "Dline wants to view source code definition names used in this directory:"
										: "Dline viewed source code definition names used in this directory:"}
								</span>
							</div>
							<CodeAccordian
								code={Array.isArray(tool.content) ? tool.content.join("\n") : (tool.content ?? "")}
								isExpanded={isExpanded}
								onToggleExpand={handleToggle}
								path={tool.path ?? ""}
							/>
						</div>
					)
				case "searchFiles":
					return (
						<div>
							<div className={HEADER_CLASSNAMES}>
								{toolIcon("search")}
								{tool.operationIsLocatedInWorkspace === false &&
									toolIcon("sign-out", "yellow", -90, "This is outside of your workspace")}
								<span className="font-bold">
									Dline wants to search this directory for <code className="break-all">{tool.regex}</code>:
								</span>
							</div>
							<SearchResultsDisplay
								content={Array.isArray(tool.content) ? tool.content.join("\n") : (tool.content ?? "")}
								filePattern={tool.filePattern}
								isExpanded={isExpanded}
								onToggleExpand={handleToggle}
								path={tool.path ?? ""}
							/>
						</div>
					)
				case "summarizeTask": {
					const status = tool.compactionStatus ?? (message.partial ? "running" : "completed")
					const content = typeof tool.content === "string" ? tool.content : ""
					if (status === "running" && !content) return null
					const isSummaryRefit = tool.compactionUnitKind === "summary_refit"
					// A failed compaction produced no summary, so it carries none of the card
					// chrome that presents one. Rendering it as a standalone error keeps the
					// compaction card a summary-only surface and lets the failure be removed
					// on its own when a Restore rewinds past it.
					if (status === "failed") {
						return (
							<div
								data-compaction-attempt-id={tool.compactionAttemptId}
								data-compaction-attempt-index={tool.compactionAttemptIndex}
								data-compaction-durable={tool.compactionDurable}
								data-compaction-operation-id={tool.compactionOperationId}
								data-compaction-pass-index={tool.compactionPassIndex}
								data-compaction-status={status}
								data-compaction-unit-index={tool.compactionUnitIndex}
								data-compaction-unit-kind={tool.compactionUnitKind}
								data-testid="compaction-failure">
								<ApiErrorBox
									error={tool.error ?? "Conversation compaction failed before completion."}
									testId="compaction-error-box"
									title="Conversation Compaction Failed"
								/>
							</div>
						)
					}
					const title =
						status === "preparing"
							? isSummaryRefit
								? "Preparing the cumulative summary for refit:"
								: "Preparing a context-safe summary:"
							: status === "waiting"
								? isSummaryRefit
									? "Waiting for the model to refit the summary:"
									: "Waiting for the model to begin compaction:"
								: status === "retrying"
									? isSummaryRefit
										? "Summary refit was interrupted; retrying:"
										: "Compaction was interrupted; retrying:"
									: status === "completed" && isSummaryRefit
										? "Cumulative summary refit completed:"
										: status === "receiving" && isSummaryRefit
											? "Dline is refitting the cumulative summary:"
											: "Dline is condensing the conversation:"
					const contentLabel =
						status === "completed"
							? isSummaryRefit
								? "Refitted summary:"
								: "Summary:"
							: status === "retrying"
								? "Partial summary (not applied):"
								: "Partial summary:"
					return (
						<div
							data-compaction-attempt-id={tool.compactionAttemptId}
							data-compaction-attempt-index={tool.compactionAttemptIndex}
							data-compaction-durable={tool.compactionDurable}
							data-compaction-operation-id={tool.compactionOperationId}
							data-compaction-pass-index={tool.compactionPassIndex}
							data-compaction-status={status}
							data-compaction-unit-index={tool.compactionUnitIndex}
							data-compaction-unit-kind={tool.compactionUnitKind}
							data-testid="compaction-pass">
							<div className="bg-code overflow-hidden border border-editor-group-border rounded-[3px]">
								<div className="flex items-center gap-2.5 px-2.5 py-2">
									<FoldVerticalIcon className="size-2" />
									<span className="min-w-0 flex-1 font-bold">{title}</span>
								</div>
								{status === "retrying" &&
									tool.retryAttempt !== undefined &&
									tool.maxRetryAttempts !== undefined && (
										<div className="px-2.5 pb-2 text-description">
											Attempt {tool.retryAttempt} of {tool.maxRetryAttempts}
										</div>
									)}
								{content ? (
									<div className="px-2.5 pb-2.5" data-testid="compaction-summary-content">
										<button
											aria-expanded={isExpanded}
											aria-label={isExpanded ? "Collapse summary" : "Expand summary"}
											className="text-description cursor-pointer select-none w-full bg-transparent border-0 p-0 text-inherit font-inherit text-left"
											onClick={handleToggle}
											type="button">
											{isExpanded ? (
												<div>
													<div className="flex items-center mb-2">
														<span className="font-bold mr-1">{contentLabel}</span>
														<div className="grow" />
														<ChevronDownIcon className="my-0.5 shrink-0 size-4" />
													</div>
													<SummaryScrollContainer>
														<span className="ph-no-capture break-words whitespace-pre-wrap">
															{content}
														</span>
													</SummaryScrollContainer>
												</div>
											) : (
												<div className="flex items-center">
													<span className="ph-no-capture whitespace-nowrap overflow-hidden text-ellipsis text-left flex-1 mr-2 [direction:rtl]">
														{`${content}\u200E`}
													</span>
													<ChevronRightIcon className="my-0.5 shrink-0 size-4" />
												</div>
											)}
										</button>
									</div>
								) : null}
							</div>
							{/* The checkpoint control renders its menu outside the card, so it must not
							    sit inside the card's clipping box or the control gets occluded. */}
							{status === "completed" && message.partial !== true && message.compactionConversationRange && (
								<CheckmarkControl hasWorkspaceCheckpoint={false} messageTs={message.ts} />
							)}
						</div>
					)
				}
				case "webFetch":
					return <WebFetchRow messageType={message.type} url={tool.path} webFetch={tool.webFetch} />
				case "webSearch":
					return <WebSearchRow messageType={message.type} query={tool.path} webSearch={tool.webSearch} />
				case "generateImage": {
					const imageGeneration = message.imageGeneration ?? parseImageGenerationPresentation(tool.imageGeneration)
					return imageGeneration ? (
						<ImageGenerationRow
							isExpanded={isExpanded}
							onAddToInput={onAddToInput}
							onToggleExpand={handleToggle}
							presentation={imageGeneration}
						/>
					) : (
						<InvisibleSpacer />
					)
				}
				case "codeExecution":
					return (
						<CodeExecutionRow codeExecution={tool.codeExecution} description={tool.path} messageType={message.type} />
					)
				case "useSkill":
					return (
						<div>
							<div className={HEADER_CLASSNAMES}>
								<LightbulbIcon className="size-2" />
								<span className="font-bold">Dline loaded the skill:</span>
							</div>
							<div className="bg-code border border-editor-group-border overflow-hidden rounded-xs py-[9px] px-2.5">
								<span className="ph-no-capture font-medium">{tool.path}</span>
							</div>
						</div>
					)
				case "loadCapability":
					return (
						<LoadCapabilityRow
							isExpanded={isExpanded}
							onToggleExpand={handleToggle}
							payload={tool.loadCapability ?? (tool as unknown as LoadCapabilityPayload)}
						/>
					)
				case "renameSymbol":
					return (
						<EditResultRow
							content={Array.isArray(tool.content) ? tool.content.join("\n") : (tool.content ?? "")}
							isExpanded={isExpanded}
							matches={tool.matches}
							onToggleExpand={handleToggle}
							toolType={tool.tool}
						/>
					)
				case "replaceText":
					return (
						<EditResultRow
							content={Array.isArray(tool.content) ? tool.content.join("\n") : (tool.content ?? "")}
							isExpanded={isExpanded}
							matches={tool.matches}
							onToggleExpand={handleToggle}
							toolType={tool.tool}
						/>
					)
				case "focusChainChanged":
					// Render auto-approved focus chain change with plan and reason
					// tool.path = newPlan, tool.content = reason
					return (
						<FocusChainChangeRow
							autoApproved
							isExpanded={isExpanded}
							onToggleExpand={handleToggle}
							plan={tool.path || ""}
							reason={Array.isArray(tool.content) ? tool.content.join("\n") : tool.content || ""}
						/>
					)
				case "statusUpdate":
					return <StatusUpdateRow text={Array.isArray(tool.content) ? tool.content.join("\n") : tool.content || ""} />
				case "actModeRespond":
					return <ActModeRespondRow text={Array.isArray(tool.content) ? tool.content.join("\n") : tool.content || ""} />
				case "killCommand":
					return (
						<KillCommandRow
							activityId={tool.activityId}
							command={tool.path || ""}
							result={Array.isArray(tool.content) ? tool.content.join("\n") : tool.content || ""}
						/>
					)
				default:
					return <InvisibleSpacer />
			}
		}

		if (message.ask === "command" || message.say === "command") {
			return (
				<CommandOutputRow
					exitCode={message.exitCode}
					icon={icon}
					isBackgroundExec={message.commandExecutionMode === "background"}
					isCollapsed={isCommandCollapsed}
					isCommandCancelled={isCommandCancelled}
					isCommandCompleted={isCommandCompleted}
					isCommandExecuting={isCommandExecuting}
					isCommandFailed={isCommandFailed}
					isCommandInterrupted={isCommandInterrupted}
					isCommandPending={isCommandPending}
					isCommandSkipped={isCommandSkipped}
					isLast={isLast}
					isOutputFullyExpanded={isOutputFullyExpanded}
					message={message}
					onCancelCommand={cancelCommand}
					onToggleCollapsed={toggleCommandCollapsed}
					setIsOutputFullyExpanded={setIsOutputFullyExpanded}
					title={title}
				/>
			)
		}

		if (message.ask === "use_subagents" || message.say === "use_subagents") {
			return <SubagentStatusRow isLast={isLast} lastModifiedMessage={lastModifiedMessage} message={message} />
		}

		if (message.ask === "use_mcp_server" || message.say === "use_mcp_server") {
			const useMcpServer = JSON.parse(message.text || "{}") as ClineAskUseMcpServer
			const server = mcpServers.find((server) => server.name === useMcpServer.serverName)
			return (
				<div>
					<div className={HEADER_CLASSNAMES}>
						{icon}
						{title}
					</div>

					<div
						className={cn("bg-code rounded-xs py-2 px-2.5 mt-2", TOOL_RESPONSE_SCROLL_CLASS)}
						data-testid="mcp-request-card">
						{useMcpServer.type === "access_mcp_resource" && (
							<McpResourceRow
								item={{
									...(findMatchingResourceOrTemplate(
										useMcpServer.uri || "",
										server?.resources,
										server?.resourceTemplates,
									) || {
										name: "",
										mimeType: "",
										description: "",
									}),
									uri: useMcpServer.uri || "",
								}}
							/>
						)}

						{useMcpServer.type === "use_mcp_tool" && (
							<div>
								{/* Keeps a click inside the tool row from reaching the row's own
								    expand handler. It is a propagation boundary, not a control, so
								    it exposes no role and no keyboard handler: keyboard events do
								    not bubble to the row the way this click does. */}
								<div
									onClickCapture={(e) => {
										e.stopPropagation()
									}}>
									<McpToolRow
										showAutoApprove={false}
										tool={{
											name: useMcpServer.toolName || "",
											description:
												server?.tools?.find((tool) => tool.name === useMcpServer.toolName)?.description ||
												"",
											autoApprove:
												server?.tools?.find((tool) => tool.name === useMcpServer.toolName)?.autoApprove ||
												false,
										}}
									/>
								</div>
								{useMcpServer.arguments && useMcpServer.arguments !== "{}" && (
									<div className="mt-2">
										<div className="mb-1 opacity-80 uppercase">Arguments</div>
										<CodeAccordian
											code={useMcpServer.arguments}
											isExpanded={true}
											language="json"
											onToggleExpand={handleToggle}
										/>
									</div>
								)}
							</div>
						)}
					</div>
				</div>
			)
		}

		switch (message.type) {
			case "say":
				switch (message.say) {
					case "api_req_started":
						return (
							<RequestStartRow
								apiRequestFailedMessage={apiRequestFailedMessage}
								clineMessages={clineMessages}
								cost={cost}
								handleToggle={handleToggle}
								isExpanded={isExpanded}
								message={message}
								mode={mode}
								reasoningContent={reasoningContent}
								responseStarted={responseStarted}
								usageInfo={usageInfo}
							/>
						)
					case "api_req_finished":
						return <InvisibleSpacer /> // we should never see this message type
					case "mcp_server_response":
						return <McpResponseDisplay responseText={message.text || ""} />
					case "mcp_notification":
						return (
							<div
								className={cn(
									"flex items-start gap-2 py-2.5 px-3 bg-quote rounded-sm text-base text-foreground opacity-90 mb-2",
									TOOL_RESPONSE_SCROLL_CLASS,
								)}
								data-testid="mcp-notification-card">
								<BellIcon className="mt-0.5 size-2 text-notification-foreground shrink-0" />
								<div className="break-words flex-1">
									<span className="font-medium">MCP Notification: </span>
									<span className="ph-no-capture">{message.text}</span>
								</div>
							</div>
						)
					case "task":
						return (
							<UserMessage
								inputKind={message.userInputKind}
								messageTs={message.ts}
								queuedInputMode={message.queuedInputMode}
								sendMessageFromChatRow={sendMessageFromChatRow}
								text={message.text}
							/>
						)
					case "text": {
						return (
							<WithCopyButton
								onMouseUp={handleMouseUp}
								position="bottom-right"
								ref={contentRef}
								textToCopy={message.text}>
								<div className="flex items-center">
									<div className={cn("flex-1 min-w-0 pl-1")}>
										<MarkdownRow markdown={message.text} showCursor={false} />
									</div>
								</div>
								{quoteButtonState.visible && (
									<QuoteButton
										left={quoteButtonState.left}
										onClick={handleQuoteClick}
										top={quoteButtonState.top}
									/>
								)}
							</WithCopyButton>
						)
					}
					case "reasoning": {
						const isReasoningStreaming = message.partial === true && taskViewState?.phase !== "completed"
						const hasReasoningText = !!message.text?.trim()
						// Show feature tips throughout the entire thinking/reasoning phase
						const _showFeatureTip = isReasoningStreaming
						return (
							<div>
								<ThinkingRow
									isExpanded={(isReasoningStreaming && hasReasoningText) || isExpanded}
									isStreaming={isReasoningStreaming}
									isVisible={true}
									onToggle={isReasoningStreaming ? undefined : handleToggle}
									reasoningContent={message.text}
									showChevron={!isReasoningStreaming || hasReasoningText}
									showTitle={true}
									title={isReasoningStreaming ? (hasReasoningText ? "Thinking..." : "Thinking") : "Thinking"}
								/>
								{isReasoningStreaming && showFeatureTips !== false && <FeatureTip />}
							</div>
						)
					}
					case "user_feedback":
						return (
							<UserMessage
								files={message.files}
								images={message.images}
								inputKind={message.userInputKind}
								messageTs={message.ts}
								queuedInputMode={message.queuedInputMode}
								sendMessageFromChatRow={sendMessageFromChatRow}
								text={message.text}
							/>
						)
					case "user_feedback_diff":
						const tool = JSON.parse(message.text || "{}") as ClineSayTool
						return (
							<div className="w-full -mt-2.5">
								<CodeAccordian
									diff={tool.diff ?? ""}
									isExpanded={isExpanded}
									isFeedback={true}
									onToggleExpand={handleToggle}
								/>
							</div>
						)
					case "error":
						return <ErrorRow errorType="error" message={message} />
					case "diff_error":
						return <ErrorRow errorType="diff_error" message={message} />
					case "clineignore_error":
						return <ErrorRow errorType="clineignore_error" message={message} />
					case "checkpoint_created":
						return (
							<CheckmarkControl
								hasWorkspaceCheckpoint={
									message.lastCheckpointHash !== undefined && checkpointManagerErrorMessage === undefined
								}
								isCheckpointCheckedOut={message.isCheckpointCheckedOut}
								messageTs={message.ts}
							/>
						)
					case "load_mcp_documentation":
						return (
							<div className="text-foreground flex items-center opacity-70 text-[12px] py-1 px-0">
								<i className="codicon codicon-book mr-1.5" />
								Loading MCP documentation
							</div>
						)
					case "generate_explanation": {
						let explanationInfo: ClineSayGenerateExplanation = {
							title: "code changes",
							fromRef: "",
							toRef: "",
							status: "generating",
						}
						try {
							if (message.text) {
								explanationInfo = JSON.parse(message.text)
							}
						} catch {
							// Use defaults if parsing fails
						}
						// Check if generation was interrupted:
						// 1. If status is "generating" but this isn't the last message, it was interrupted
						// 2. If status is "generating" and lastModifiedMessage is a resume ask, task was just cancelled
						const wasCancelled =
							explanationInfo.status === "generating" &&
							(!isLast ||
								lastModifiedMessage?.ask === "resume_task" ||
								lastModifiedMessage?.ask === "resume_completed_task")
						const isGenerating = explanationInfo.status === "generating" && !wasCancelled
						const isError = explanationInfo.status === "error"
						return (
							<div
								className={cn(
									"bg-code flex flex-col border border-editor-group-border rounded-sm py-2.5 px-3",
									TOOL_RESPONSE_SCROLL_CLASS,
								)}
								data-testid="generate-explanation-scroll">
								<div className="flex items-center">
									{isGenerating ? (
										<ProgressIndicator />
									) : isError ? (
										<CircleXIcon className="size-2 mr-2 text-error" />
									) : wasCancelled ? (
										<CircleSlashIcon className="size-2 mr-2" />
									) : (
										<CheckIcon className="size-2 mr-2 text-success" />
									)}
									<span className="font-semibold">
										{isGenerating
											? "Generating explanation"
											: isError
												? "Failed to generate explanation"
												: wasCancelled
													? "Explanation cancelled"
													: "Generated explanation"}
									</span>
								</div>
								{isError && explanationInfo.error && (
									<div className="opacity-80 ml-6 mt-1.5 text-error break-words">{explanationInfo.error}</div>
								)}
								{!isError && (explanationInfo.title || explanationInfo.fromRef) && (
									<div className="opacity-80 ml-6 mt-1.5">
										<div>{explanationInfo.title}</div>
										{explanationInfo.fromRef && (
											<div className="opacity-70 mt-1.5 break-all text-xs">
												<code className="bg-quote rounded-sm py-0.5 pr-1.5">
													{explanationInfo.fromRef}
												</code>
												<ArrowRightIcon className="inline size-2 mx-1" />
												<code className="bg-quote rounded-sm py-0.5 px-1.5">
													{explanationInfo.toRef || "working directory"}
												</code>
											</div>
										)}
									</div>
								)}
							</div>
						)
					}
					case "completion_result":
						const { hasChanges, text } = readCompletionChanges(message)

						return (
							<CompletionOutputRow
								explainChangesDisabled={explainChangesDisabled}
								handleQuoteClick={handleQuoteClick}
								headClassNames={HEADER_CLASSNAMES}
								messageTs={message.ts}
								quoteButtonState={quoteButtonState}
								seeNewChangesDisabled={seeNewChangesDisabled}
								setExplainChangesDisabled={setExplainChangesDisabled}
								setSeeNewChangesDisabled={setSeeNewChangesDisabled}
								showActionRow={message.partial !== true && hasChanges}
								text={text || ""}
							/>
						)
					case "shell_integration_warning":
						return (
							<div className="flex flex-col bg-warning/20 p-2 rounded-xs border border-error">
								<div className="flex items-center mb-1">
									<TriangleAlertIcon className="mr-2 size-2 stroke-3 text-error" />
									<span className="font-medium text-foreground">Shell Integration Unavailable</span>
								</div>
								<div className="text-foreground opacity-80">
									Dline may have trouble viewing the command's output. Please update VSCode (
									<code>CMD/CTRL + Shift + P</code> → "Update") and make sure you're using a supported shell:
									zsh, bash, fish, or PowerShell (<code>CMD/CTRL + Shift + P</code> → "Terminal: Select Default
									Profile").
									<a
										className="px-1"
										href="https://github.com/cline/cline/wiki/Troubleshooting-%E2%80%90-Shell-Integration-Unavailable">
										Still having trouble?
									</a>
								</div>
							</div>
						)
					case "error_retry":
						try {
							return <AutoRetryErrorBox info={JSON.parse(message.text || "{}")} startedAt={message.ts} />
						} catch (_e) {
							// Fallback if JSON parsing fails
							return <ApiErrorBox error={message.text} testId="error-retry-box" />
						}
					case "hook_status":
						return <HookMessage CommandOutput={CommandOutputContent} message={message} />
					case "hook_output_stream":
						// hook_output_stream messages are combined with hook_status messages, so we don't render them separately
						return <InvisibleSpacer />
					case "subagent":
						return <SubagentStatusRow isLast={isLast} lastModifiedMessage={lastModifiedMessage} message={message} />
					case "command_output":
						// command_output is merged into the command message by combineCommandSequences.
						// Orphans that leak through are suppressed to avoid standalone empty rows.
						return <InvisibleSpacer />
					case "shell_integration_warning_with_suggestion":
						const isBackgroundModeEnabled = vscodeTerminalExecutionMode === "backgroundExec"
						return (
							<div className="p-2 bg-link/10 border border-link/30 rounded-xs">
								<div className="flex items-center mb-1">
									<LightbulbIcon className="mr-1.5 size-2 text-link" />
									<span className="font-medium text-foreground">Shell integration issues</span>
								</div>
								<div className="text-foreground opacity-90 mb-2">
									Since you're experiencing repeated shell integration issues, we recommend switching to
									Background Terminal mode for better reliability.
								</div>
								<button
									className={cn(
										"bg-button-background text-button-foreground border-0 rounded-xs py-1.5 px-3 text-[12px] flex items-center gap-1.5 cursor-pointer hover:bg-button-hover",
										{
											"cursor-default opacity-80 bg-success": isBackgroundModeEnabled,
										},
									)}
									disabled={isBackgroundModeEnabled}
									onClick={async () => {
										try {
											// Enable background terminal execution mode
											await UiServiceClient.setTerminalExecutionMode(BooleanRequest.create({ value: true }))
										} catch (error) {
											console.error("Failed to enable background terminal:", error)
										}
									}}
									type="button">
									<SettingsIcon className="size-2" />
									{isBackgroundModeEnabled
										? "Background Terminal Enabled"
										: "Enable Background Terminal (Recommended)"}
								</button>
							</div>
						)
					case "task_progress":
						return <InvisibleSpacer /> // task_progress messages should be displayed in TaskHeader only, not in chat
					default:
						return (
							<div>
								{title && (
									<div className={HEADER_CLASSNAMES}>
										{icon}
										{title}
									</div>
								)}
								<div className="pt-1">
									<MarkdownRow markdown={message.text} />
								</div>
							</div>
						)
				}
			case "ask":
				switch (message.ask) {
					case "change_todo_list":
						try {
							const data = message.text ? JSON.parse(message.text) : { plan: "", reason: "" }
							if (data.plan) {
								return (
									<FocusChainChangeRow
										isExpanded={isExpanded}
										onToggleExpand={handleToggle}
										plan={data.plan}
										reason={data.reason || ""}
									/>
								)
							}
						} catch {}
						return <InvisibleSpacer />
					case "mistake_limit_reached":
						return <ErrorRow errorType="mistake_limit_reached" message={message} />
					case "completion_result":
						if (message.text) {
							const { hasChanges, text } = readCompletionChanges(message)
							return (
								<CompletionOutputRow
									explainChangesDisabled={explainChangesDisabled}
									handleQuoteClick={handleQuoteClick}
									headClassNames={HEADER_CLASSNAMES}
									messageTs={message.ts}
									quoteButtonState={quoteButtonState}
									seeNewChangesDisabled={seeNewChangesDisabled}
									setExplainChangesDisabled={setExplainChangesDisabled}
									setSeeNewChangesDisabled={setSeeNewChangesDisabled}
									showActionRow={message.partial !== true && hasChanges}
									text={text || ""}
								/>
							)
						}
						// Virtuoso cannot handle zero-height items; render a spacer instead of null
						return <InvisibleSpacer />
					case "followup":
						let question: string | undefined
						let options: string[] | undefined
						let selected: string | undefined
						try {
							const parsedMessage = JSON.parse(message.text || "{}") as ClineAskQuestion
							question = parsedMessage.question
							options = parsedMessage.options
							selected = parsedMessage.selected
						} catch (_e) {
							// legacy messages would pass question directly
							question = message.text
						}

						return (
							<div>
								{title && (
									<div className={HEADER_CLASSNAMES}>
										{icon}
										{title}
									</div>
								)}
								<WithCopyButton
									className="pt-1"
									onMouseUp={handleMouseUp}
									position="bottom-right"
									ref={contentRef}
									textToCopy={question}>
									<MarkdownRow markdown={question} />
									{quoteButtonState.visible && (
										<QuoteButton
											left={quoteButtonState.left}
											onClick={() => {
												handleQuoteClick()
											}}
											top={quoteButtonState.top}
										/>
									)}
								</WithCopyButton>
								<div className="pt-3">
									<OptionsButtons
										isActive={
											message.type === "ask" &&
											message.ask === "followup" &&
											taskViewState?.activeInteraction?.kind === "followup" &&
											taskViewState.activeInteraction.askMessageTs === message.ts &&
											taskViewState.activeInteraction.interactionId === message.interactionId &&
											taskViewState.input.enabled === true
										}
										onSelect={(option) =>
											onFollowupOptionSelect ? onFollowupOptionSelect(message, option) : Promise.resolve()
										}
										options={options}
										selected={selected}
									/>
								</div>
							</div>
						)
					case "new_task":
						return (
							<div>
								<div className={HEADER_CLASSNAMES}>
									<FilePlus2Icon className="size-2" />
									<span className="text-foreground font-bold">Dline wants to start a new task:</span>
								</div>
								<NewTaskPreview task={message.text || ""} />
							</div>
						)
					case "spawn_task": {
						let spawnTask: string | undefined
						let spawnMode: ClineAskSpawnTask["mode"] | undefined
						let spawnContext: string | undefined
						try {
							const parsed = JSON.parse(message.text || "{}") as ClineAskSpawnTask
							spawnTask = parsed.task
							spawnMode = parsed.mode === "plan" || parsed.mode === "act" ? parsed.mode : undefined
							spawnContext = parsed.context
						} catch {
							spawnTask = message.text
						}
						return (
							<div>
								<div className={HEADER_CLASSNAMES}>
									<FilePlus2Icon className="size-2" />
									<span className="text-foreground font-bold">Dline wants to spawn an independent task:</span>
								</div>
								<NewTaskPreview
									context={spawnContext ? [spawnContext] : undefined}
									mode={spawnMode}
									task={spawnTask || message.text || ""}
								/>
							</div>
						)
					}
					case "condense":
						return (
							<div>
								<div className={HEADER_CLASSNAMES}>
									<FilePlus2Icon className="size-2" />
									<span className="text-foreground font-bold">Dline wants to condense your conversation:</span>
								</div>
								<SummaryScrollContainer>
									<NewTaskPreview task={message.text || ""} />
								</SummaryScrollContainer>
							</div>
						)
					case "report_bug":
						return (
							<div>
								<div className={HEADER_CLASSNAMES}>
									<FilePlus2Icon className="size-2" />
									<span className="text-foreground font-bold">Dline wants to create a Github issue:</span>
								</div>
								<ReportBugPreview data={message.text || ""} />
							</div>
						)
					case "make_plan": {
						let response = message.text || ""
						try {
							const parsedMessage = JSON.parse(message.text || "{}") as ClineMakePlanResponse
							response = parsedMessage.response || response
						} catch (_e) {
							// Keep malformed current records readable instead of failing the row.
						}
						return <PlanCompletionOutputRow headClassNames={HEADER_CLASSNAMES} text={response} />
					}
					case "command_output":
						return (
							<CommandOutputContent
								isContainerExpanded={true}
								isOutputFullyExpanded={isOutputFullyExpanded}
								onToggle={() => setIsOutputFullyExpanded(!isOutputFullyExpanded)}
								output={message.text || ""}
							/>
						)
					case "qna_respond": {
						if (!message.text) {
							return <InvisibleSpacer />
						}
						let answer = message.text
						try {
							const parsed = JSON.parse(message.text) as { response: string }
							answer = parsed.response || answer
						} catch {
							// legacy plain-text format — use as-is
						}
						return <QnaOutputRow headClassNames={HEADER_CLASSNAMES} text={answer} />
					}
					case "generate_report": {
						if (!message.text) {
							return <InvisibleSpacer />
						}
						let title = ""
						let content = message.text
						try {
							const parsed = JSON.parse(message.text) as { title: string; content: string }
							title = parsed.title || ""
							content = parsed.content || content
						} catch {
							// legacy format — use text as content
						}
						return <GenerateReportRow content={content} headClassNames={HEADER_CLASSNAMES} title={title} />
					}
					case "status_acknowledgment": {
						const text = message.text || ""
						return <StatusUpdateRow headClassNames={HEADER_CLASSNAMES} text={text} />
					}
					default:
						return <InvisibleSpacer />
				}
		}
	},
)
