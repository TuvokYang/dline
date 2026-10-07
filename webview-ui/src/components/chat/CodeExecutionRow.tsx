import type { CodeExecutionPresentationV1, HostedCodeExecutionOperation } from "@shared/code-execution-tools"
import type { ClineSayTool } from "@shared/ExtensionMessage"
import { ChevronDownIcon, ChevronRightIcon, TerminalIcon, TriangleAlertIcon } from "lucide-react"
import { useState } from "react"
import ToolCardHeader from "./ToolCardHeader"

interface CodeExecutionRowProps {
	messageType: "ask" | "say"
	codeExecution?: ClineSayTool["codeExecution"]
	/** Message-level fallback used when the provider never described the call. */
	description?: string
}

function operationTitle(messageType: "ask" | "say", operation: HostedCodeExecutionOperation | undefined): string {
	switch (operation?.type) {
		case "bash":
			return messageType === "ask" ? "Dline wants to run a command in the sandbox:" : "Dline ran a command in the sandbox:"
		case "text_editor":
			return messageType === "ask" ? "Dline wants to edit a sandbox file:" : "Dline edited a sandbox file:"
		default:
			return messageType === "ask" ? "Dline wants to run code in the sandbox:" : "Dline ran code in the sandbox:"
	}
}

/** The exact text submitted to the provider, which is what makes a failed run diagnosable. */
function submittedText(operation: HostedCodeExecutionOperation | undefined, fallback: string | undefined): string {
	switch (operation?.type) {
		case "code":
			return operation.code
		case "bash":
			return operation.command
		case "text_editor":
			return operation.path ? `${operation.command} ${operation.path}` : operation.command
		default:
			return fallback ?? ""
	}
}

function statusLabel(status: CodeExecutionPresentationV1["status"]): string {
	switch (status) {
		case "running":
			return "Running"
		case "completed":
			return "Completed"
		case "failed":
			return "Failed"
	}
}

const OutputBlock = ({ label, text, tone }: { label: string; text: string; tone?: "error" }) => (
	<div className="space-y-1">
		<div className={`text-xs font-semibold ${tone === "error" ? "text-error" : "text-description"}`}>{label}</div>
		<pre className="ph-no-capture m-0 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">{text}</pre>
	</div>
)

const CodeExecutionRow = ({ messageType, codeExecution, description }: CodeExecutionRowProps) => {
	const source = codeExecution?.source
	const sourceLabel = source ? `${source.label} (Hosted)` : undefined
	const operation = codeExecution?.operation
	const code = submittedText(operation, description)
	const output = codeExecution?.output
	const hasOutput =
		output !== undefined &&
		(output.stdout !== undefined ||
			output.stderr !== undefined ||
			output.returnCode !== undefined ||
			(output.files?.length ?? 0) > 0)
	const [outputExpanded, setOutputExpanded] = useState(true)
	const toggleOutput = () => setOutputExpanded((expanded) => !expanded)

	return (
		<div className="flex max-h-[40vh] flex-col overflow-hidden pr-1" data-testid="code-execution-card">
			<ToolCardHeader
				expansion={hasOutput ? { expanded: outputExpanded, onToggle: toggleOutput } : undefined}
				icon={<TerminalIcon className="size-3" />}
				testId="code-execution-header"
				title={operationTitle(messageType, operation)}
			/>
			<div className="flex min-h-0 flex-1 flex-col space-y-2 overflow-hidden rounded-xs border border-editor-group-border bg-code px-2.5 py-[9px] select-text">
				<div className="flex items-center justify-between gap-2">
					{sourceLabel && <div className="text-xs font-semibold text-description">{sourceLabel}</div>}
					{codeExecution && (
						<div className="text-xs text-description" data-testid="code-execution-status">
							{statusLabel(codeExecution.status)}
						</div>
					)}
				</div>
				{code && (
					<pre
						className="ph-no-capture m-0 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-xs"
						data-testid="code-execution-code">
						{code}
					</pre>
				)}
				{codeExecution?.error && (
					<div className="flex items-start gap-2 rounded border border-error/40 bg-error/10 p-2 text-error">
						<TriangleAlertIcon className="mt-0.5 size-3 shrink-0" />
						<div className="min-w-0 space-y-0.5">
							{codeExecution.errorCode && (
								<div className="font-mono text-xs font-semibold" data-testid="code-execution-error-code">
									{codeExecution.errorCode}
								</div>
							)}
							<span className="ph-no-capture break-words text-xs">{codeExecution.error}</span>
						</div>
					</div>
				)}
				{hasOutput && (
					<>
						<button
							aria-expanded={outputExpanded}
							aria-label={outputExpanded ? "Collapse execution output" : "Expand execution output"}
							className="flex w-full cursor-pointer items-center gap-1 border-0 border-t border-editor-widget-border/50 bg-transparent pt-2 text-left text-xs text-description"
							data-testid="code-execution-output-toggle"
							onClick={toggleOutput}
							type="button">
							{outputExpanded ? (
								<ChevronDownIcon aria-hidden="true" className="size-3 shrink-0" />
							) : (
								<ChevronRightIcon aria-hidden="true" className="size-3 shrink-0" />
							)}
							<span>{outputExpanded ? "Hide output" : "Show output"}</span>
						</button>
						{outputExpanded && (
							<div
								className="min-h-0 flex-1 space-y-2 overflow-y-auto border-t border-editor-widget-border/50 pt-2"
								data-testid="code-execution-output">
								{output.stdout !== undefined && <OutputBlock label="stdout" text={output.stdout} />}
								{output.stderr !== undefined && <OutputBlock label="stderr" text={output.stderr} tone="error" />}
								{output.returnCode !== undefined && (
									<div className="text-xs text-description" data-testid="code-execution-return-code">
										Exit code: {output.returnCode}
									</div>
								)}
								{(output.files?.length ?? 0) > 0 && (
									<div className="space-y-0.5">
										<div className="text-xs font-semibold text-description">Files</div>
										{output.files?.map((file) => (
											<div className="ph-no-capture break-all font-mono text-xs" key={file}>
												{file}
											</div>
										))}
									</div>
								)}
							</div>
						)}
					</>
				)}
			</div>
		</div>
	)
}

export default CodeExecutionRow
