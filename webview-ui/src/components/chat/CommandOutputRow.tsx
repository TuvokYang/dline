import { COMMAND_OUTPUT_STRING, COMMAND_REQ_APP_STRING } from "@shared/combineCommandSequences"
import { COMMAND_LOG_NOTICE_LABEL, findCommandLogNotice } from "@shared/command-log-notice"
import { ClineMessage } from "@shared/ExtensionMessage"
import AnsiUp from "ansi-to-html"
import DOMPurify from "dompurify"
import { BringToFrontIcon, CircleSlashIcon, FolderRootIcon, SendToBackIcon, TerminalIcon } from "lucide-react"
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import CodeBlock from "../common/CodeBlock"
import { CopyButton } from "../common/CopyButton"
import { OpenFilePathLink } from "../common/OpenFilePathLink"
import { getCommandOutputSummary, sanitizeCommandOutput, stripCommandPromptArtifacts } from "./command-output"
import ExpandHandle from "./ExpandHandle"

// ANSI color converter instance (shared across renders for performance)
const ansiUp = new AnsiUp()

// ANSI escape sequence regex pattern for detection
const ANSI_ESCAPE_PATTERN = /\x1b\[[\d;]*[A-Za-z]/

/**
 * Check if a string contains ANSI escape sequences.
 */
function hasAnsiSequences(text: string): boolean {
	return ANSI_ESCAPE_PATTERN.test(text)
}

/**
 * Height ceiling for the command text before it collapses.
 *
 * A long here-doc or a generated one-liner would otherwise push the output and
 * the controls far below the fold, so the command claims at most this much of
 * the viewport and offers a handle to see the rest.
 */
const COMMAND_TEXT_MAX_HEIGHT = "40vh"

/**
 * Render the command text, collapsing it when it would claim too much height.
 *
 * Collapsing is decided from the measured element rather than the character
 * count: wrapping makes the rendered height the only honest signal, and a
 * command that fits must not grow a handle it does not need.
 */
const CollapsibleCommandText = memo(({ command }: { command: string }) => {
	const scrollRef = useRef<HTMLDivElement>(null)
	const [isExpanded, setIsExpanded] = useState(false)
	const [isOverflowing, setIsOverflowing] = useState(false)

	useLayoutEffect(() => {
		const element = scrollRef.current
		if (!element) return

		const measure = () => {
			setIsOverflowing(element.scrollHeight > element.clientHeight + 1)
		}
		measure()

		// Wrapping depends on the panel width, so a resize can change the verdict
		// without the command text changing at all.
		if (typeof ResizeObserver === "undefined") return
		const observer = new ResizeObserver(measure)
		observer.observe(element)
		return () => observer.disconnect()
	}, [command])

	const toggle = useCallback(() => setIsExpanded((expanded) => !expanded), [])

	return (
		<div className={cn("relative", isOverflowing && "mb-2")}>
			<div
				className="overflow-y-auto"
				data-testid="command-text-scroll"
				ref={scrollRef}
				style={{ maxHeight: isExpanded ? undefined : COMMAND_TEXT_MAX_HEIGHT }}>
				<CodeBlock forceWrap={true} source={`${"```"}shell\n${command}\n${"```"}`} />
			</div>
			{isOverflowing && (
				// The surrounding row toggles its own collapsed state on click, so
				// the handle must not let that click through.
				<div onClick={(event) => event.stopPropagation()}>
					<ExpandHandle className="bg-description" isExpanded={isExpanded} onToggle={toggle} />
				</div>
			)}
		</div>
	)
})

export const CommandOutputContent = memo(
	({
		output,
		isOutputFullyExpanded,
		onToggle,
		isContainerExpanded,
		isCommandActive = false,
		logPath,
		presentation = "default",
	}: {
		output: string
		isOutputFullyExpanded: boolean
		onToggle: () => void
		isContainerExpanded: boolean
		isCommandActive?: boolean
		logPath?: string
		presentation?: "default" | "activity"
	}) => {
		const displayOutput = sanitizeCommandOutput(stripCommandPromptArtifacts(output))
		const outputLines = displayOutput.split("\n")
		const lineCount = outputLines.length
		const shouldAutoShow = lineCount <= 5
		const outputRef = useRef<HTMLDivElement>(null)

		useEffect(() => {
			// Auto-scroll to bottom when streaming output grows
			if (outputRef.current) {
				outputRef.current.scrollTop = outputRef.current.scrollHeight
				setTimeout(() => {
					if (outputRef.current) {
						outputRef.current.scrollTop = outputRef.current.scrollHeight
					}
				}, 50)
			}
		}, [output])

		if (!isContainerExpanded) {
			return null
		}

		// The notice is the only in-output marker; `logPath` is the structured fact and wins.
		const logNotice = findCommandLogNotice(displayOutput)
		const logFilePath = logPath ?? logNotice?.logFilePath ?? null
		const logPathLineStart = logNotice?.start ?? -1
		const logPathLineEnd = logNotice?.end ?? -1

		/**
		 * Render ANSI-colored output as sanitized HTML.
		 * Converts ANSI escape sequences to HTML spans with inline styles.
		 */
		const renderAnsiOutput = (text: string) => {
			const rawHtml = ansiUp.toHtml(text)
			const cleanHtml = DOMPurify.sanitize(rawHtml, {
				ALLOWED_TAGS: ["span", "br"],
				ALLOWED_ATTR: ["style"],
			})
			return (
				<pre
					className="text-white p-3 m-0 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all"
					dangerouslySetInnerHTML={{ __html: cleanHtml }}
					style={{ backgroundColor: "var(--vscode-editor-background, #1e1e1e)" }}
				/>
			)
		}

		const outputGroupClassName = cn({
			"border border-editor-group-border rounded-sm": presentation === "default",
			"border-0 rounded-none": presentation === "activity",
		})
		const logRowClassName = cn("px-3 py-2 transition-colors", {
			"mx-2 my-1.5 rounded-sm bg-banner-background hover:brightness-110": presentation === "default",
			"border-t border-editor-widget-border/25 bg-toolbar-hover/20 hover:bg-toolbar-hover/35": presentation === "activity",
		})

		const renderOutput = () => {
			const renderSegment = hasAnsiSequences(displayOutput)
				? renderAnsiOutput
				: (text: string) => <CodeBlock forceWrap={true} source={`${"```"}shell\n${text}\n${"```"}`} />

			if (!logFilePath) {
				return renderSegment(displayOutput)
			}

			// Replace the in-output notice line, when present, with one clickable log link.
			const beforeLogPath = logPathLineStart >= 0 ? displayOutput.substring(0, logPathLineStart) : displayOutput
			const afterLogPath = logPathLineStart >= 0 && logPathLineEnd !== -1 ? displayOutput.substring(logPathLineEnd) : ""
			return (
				<div className={outputGroupClassName}>
					{beforeLogPath && renderSegment(beforeLogPath)}
					<div className={logRowClassName} data-testid={presentation === "activity" ? "activity-log-row" : undefined}>
						<OpenFilePathLink filePath={logFilePath} label={COMMAND_LOG_NOTICE_LABEL} />
					</div>
					{afterLogPath && renderSegment(afterLogPath)}
				</div>
			)
		}

		// Keep every long output independently scrollable without allowing it to consume the whole view.
		const maxH = shouldAutoShow
			? undefined
			: presentation === "activity"
				? isOutputFullyExpanded
					? "max-h-[50vh]"
					: "max-h-[96px]"
				: isOutputFullyExpanded
					? "max-h-[80vh]"
					: "max-h-[120px]"

		return (
			<div
				className={cn("w-full relative pb-0 overflow-visible bg-code", {
					"border-t border-editor-group-border rounded-sm": presentation === "default",
					"border-t border-editor-widget-border/25 rounded-none": presentation === "activity",
					"rounded-b-none": presentation === "default" && lineCount > 5 && !shouldAutoShow,
				})}
				data-testid={presentation === "activity" ? "activity-command-output" : undefined}>
				<div
					className={cn("text-white scroll-smooth bg-code overflow-auto", {
						[maxH || ""]: !!maxH,
						"overflow-y-visible": shouldAutoShow,
					})}
					data-testid="command-output-scroll"
					ref={outputRef}>
					<div className="bg-code">{renderOutput()}</div>
				</div>
				{lineCount > 5 && !shouldAutoShow && <ExpandHandle isExpanded={isOutputFullyExpanded} onToggle={onToggle} />}
			</div>
		)
	},
)

CommandOutputContent.displayName = "CommandOutputContent"

export const CommandOutputRow = memo(
	({
		message,
		isCommandExecuting = false,
		isCommandPending = false,
		isCommandCompleted = false,
		isCommandFailed = false,
		isCommandCancelled = false,
		isCommandInterrupted = false,
		isCommandSkipped = false,
		isBackgroundExec = false,
		onCancelCommand,
		icon,
		title,
		isOutputFullyExpanded,
		setIsOutputFullyExpanded,
		isCollapsed,
		onToggleCollapsed,
	}: {
		message: ClineMessage
		exitCode?: number | null
		isCommandExecuting?: boolean
		isCommandPending?: boolean
		isCommandCompleted?: boolean
		isCommandFailed?: boolean
		isCommandCancelled?: boolean
		isCommandInterrupted?: boolean
		isCommandSkipped?: boolean
		isBackgroundExec?: boolean
		isLast?: boolean
		onCancelCommand?: () => void
		icon?: JSX.Element | null
		title?: JSX.Element | null
		isOutputFullyExpanded: boolean
		setIsOutputFullyExpanded: (expanded: boolean) => void
		isCollapsed: boolean
		onToggleCollapsed: () => void
	}) => {
		const exitCode = message.exitCode
		const colors = getStatusColor(isCommandExecuting, isCommandPending, isCommandCompleted, isCommandFailed, exitCode)
		const statusText = getCommandStatusText(
			isCommandExecuting,
			isCommandPending,
			isCommandCompleted,
			isCommandFailed,
			isCommandCancelled,
			isCommandInterrupted,
			exitCode,
		)
		const isActive = isCommandExecuting || isCommandPending
		const isNeutralStop = isCommandCancelled || isCommandInterrupted || isCommandSkipped
		const CommandStatusIcon = isNeutralStop ? CircleSlashIcon : TerminalIcon
		const commandStatusIcon = (
			<CommandStatusIcon
				aria-hidden="true"
				className={cn("size-2 shrink-0", isNeutralStop ? "text-description" : colors.text, isActive && "animate-pulse")}
				data-testid="command-status-icon"
			/>
		)

		const splitMessage = (text: string) => {
			const outputIndex = text.indexOf(COMMAND_OUTPUT_STRING)
			if (outputIndex === -1) {
				return { command: text, output: "" }
			}
			return {
				command: text.slice(0, outputIndex).trim(),
				output: sanitizeCommandOutput(text.slice(outputIndex + COMMAND_OUTPUT_STRING.length).trim()),
			}
		}

		const { command: rawCommand, output } = splitMessage(message.text || "")
		const outputSummary = getCommandOutputSummary(output)

		const requestsApproval = rawCommand.endsWith(COMMAND_REQ_APP_STRING)
		const commandPresentation = requestsApproval ? rawCommand.slice(0, -COMMAND_REQ_APP_STRING.length) : rawCommand
		const workingDirectoryMarker = "\n\nWorking directory: "
		const workingDirectoryIndex = commandPresentation.lastIndexOf(workingDirectoryMarker)
		const command =
			workingDirectoryIndex === -1 ? commandPresentation : commandPresentation.slice(0, workingDirectoryIndex).trimEnd()
		const workdirectory =
			workingDirectoryIndex === -1
				? undefined
				: commandPresentation.slice(workingDirectoryIndex + workingDirectoryMarker.length).trim()
		const showCancelButton = isActive && typeof onCancelCommand === "function"
		const ExecutionModeIcon = isBackgroundExec ? SendToBackIcon : BringToFrontIcon
		const executionModeLabel = isBackgroundExec ? "Background" : "Foreground"
		const executionModeIndicator = (
			<div
				aria-label={`Execution mode: ${executionModeLabel}`}
				className={cn(
					"flex min-w-[88px] shrink-0 items-center justify-center gap-1 border px-1.5 py-0.5 text-[11px] font-medium rounded-xs",
					isBackgroundExec
						? "border-editor-warning-foreground/40 bg-editor-warning-foreground/10 text-editor-warning-foreground"
						: "border-info/40 bg-info/10 text-info",
				)}
				data-testid="command-execution-mode">
				<ExecutionModeIcon aria-hidden="true" className="size-2.5 shrink-0" />
				<span>{executionModeLabel}</span>
			</div>
		)

		const commandHeader = (
			<div className="flex items-center gap-2.5 mb-3">
				{icon}
				{title}
			</div>
		)

		// Collapsed bar — shows compact state for both completed and running commands
		if (isCollapsed) {
			return (
				<>
					{commandHeader}
					<div
						className={cn("w-full flex items-center gap-2 p-2 rounded-xs transition-colors border", {
							"bg-success/10 border-success/30": exitCode === 0,
							"bg-error/10 border-error/30": exitCode != null && exitCode !== 0,
							"bg-editor-warning-foreground/10 border-editor-warning-foreground/30": isCommandPending,
							"bg-description/10 border-description/30": exitCode == null && !isCommandPending,
							"bg-success/5 border-success/20": isCommandExecuting,
						})}
						data-testid="command-card">
						<button
							aria-label={command}
							className="flex min-w-0 flex-1 items-center gap-2 cursor-pointer"
							onClick={onToggleCollapsed}
							type="button">
							{commandStatusIcon}
							<span className="min-w-0 flex-1 text-left">
								<span className="block truncate text-sm opacity-70">{command}</span>
								{outputSummary && (
									<span
										className="mt-0.5 block truncate font-mono text-[10px] text-description"
										data-testid="command-output-summary">
										{outputSummary}
									</span>
								)}
							</span>
						</button>
						{executionModeIndicator}
						<CopyButton ariaLabel="Copy command" className="h-5" textToCopy={command} />
						{showCancelButton && (
							<Button
								className="h-6 border px-2 py-0 text-[11px] leading-none"
								onClick={onCancelCommand}
								size="sm"
								variant="danger">
								Cancel
							</Button>
						)}
					</div>
				</>
			)
		}

		return (
			<>
				{commandHeader}
				<div
					className="bg-code rounded-sm border border-editor-group-border"
					data-testid="command-card"
					style={{ transition: "all 0.3s ease-in-out" }}>
					{command && (
						<div
							className={cn(
								"bg-code flex items-center justify-between px-2 py-2.5 border-b border-editor-group-border rounded-sm rounded-b-none overflow-hidden",
								{
									"cursor-pointer": true,
								},
							)}
							onClick={onToggleCollapsed}>
							<div className="flex items-center gap-2 flex-1 min-w-0">
								{commandStatusIcon}
								<span className={cn("font-medium text-base shrink-0", colors.text)}>{statusText}</span>
							</div>
							<div className="flex items-center gap-2 shrink-0">
								{executionModeIndicator}
								<div className="flex items-center" onClick={(event) => event.stopPropagation()}>
									<CopyButton ariaLabel="Copy command" className="h-5" textToCopy={command} />
								</div>
								{showCancelButton && (
									<Button
										className="h-5 border px-2 py-0 text-[11px] leading-none"
										onClick={(e) => {
											e.stopPropagation()
											onCancelCommand?.()
										}}
										size="sm"
										variant="danger">
										Cancel
									</Button>
								)}
							</div>
						</div>
					)}

					<div
						className={cn("opacity-60 text-sm", {
							"bg-success/5": exitCode === 0,
							"bg-error/10": exitCode != null && exitCode !== 0,
							"bg-code": exitCode == null || exitCode === undefined,
						})}
						data-testid="command-line">
						<CollapsibleCommandText command={command} />
					</div>

					{(output.length > 0 || message.logPath) && (
						<CommandOutputContent
							isCommandActive={isActive}
							isContainerExpanded={true}
							isOutputFullyExpanded={isOutputFullyExpanded}
							logPath={message.logPath}
							onToggle={() => setIsOutputFullyExpanded(!isOutputFullyExpanded)}
							output={output}
						/>
					)}

					{requestsApproval && (
						<div className="flex items-center gap-2.5 border-t border-editor-group-border p-2 text-[12px] text-editor-warning-foreground">
							<i className="codicon codicon-warning" />
							<span>The model has determined this command requires explicit approval.</span>
						</div>
					)}

					{workdirectory && (
						<div
							className="flex min-w-0 items-center gap-2 border-t border-editor-group-border px-3 py-2 text-xs text-description"
							data-testid="command-workdirectory">
							<span aria-label="Working directory" className="shrink-0" title="Working directory">
								<FolderRootIcon aria-hidden="true" className="size-3" />
							</span>
							<span className="min-w-0 break-all font-mono text-foreground" title={workdirectory}>
								{workdirectory}
							</span>
						</div>
					)}
				</div>
			</>
		)
	},
)

CommandOutputRow.displayName = "CommandOutputRow"

const CommandStatusMap = {
	running: "Running",
	pending: "Pending",
	success: "Success",
	failed: "Failed",
	cancelled: "Cancelled",
	interrupted: "Interrupted",
	completed: "Completed",
	skipped: "Skipped",
}

function getCommandStatusText(
	isExecuting: boolean,
	isPending: boolean,
	isCompleted: boolean,
	isFailed: boolean,
	isCancelled: boolean,
	isInterrupted: boolean,
	exitCode?: number | null,
): string {
	if (isExecuting) return CommandStatusMap.running
	if (isPending) return CommandStatusMap.pending
	if (isFailed) return CommandStatusMap.failed
	if (isCancelled) return CommandStatusMap.cancelled
	if (isInterrupted) return CommandStatusMap.interrupted
	if (isCompleted) {
		if (exitCode === 0) return CommandStatusMap.success
		if (exitCode != null) return CommandStatusMap.failed
		return CommandStatusMap.completed
	}
	return CommandStatusMap.skipped
}

function getStatusColor(
	isExecuting: boolean,
	isPending: boolean,
	isCompleted: boolean,
	isFailed: boolean,
	exitCode?: number | null,
): { dot: string; text: string } {
	if (isExecuting) return { dot: "bg-info animate-pulse", text: "text-info" }
	if (isPending) return { dot: "bg-editor-warning-foreground", text: "text-editor-warning-foreground" }
	if (isFailed) return { dot: "bg-error", text: "text-error" }
	if (isCompleted) {
		if (exitCode === 0) return { dot: "bg-success", text: "text-success" }
		if (exitCode != null) return { dot: "bg-error", text: "text-error" }
	}
	return { dot: "bg-description", text: "text-description" }
}
