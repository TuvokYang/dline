import type { ComponentType, ReactElement } from "react"
import {
	ApprovalRenderer,
	CommandRenderer,
	CompletionRenderer,
	ConversationRenderer,
	ErrorRenderer,
	FocusChainRenderer,
	type PresentationProps,
	ReportRenderer,
	ResumeRenderer,
} from "./renderers/PresentationRenderers"

export const PRESENTATION_KINDS = [
	"tool_approval",
	"command_approval",
	"browser_approval",
	"mcp_approval",
	"subagent_approval",
	"spawn_task_approval",
	// Legacy presentation key retained for the existing FocusChainRenderer.
	"focus_chain_change",
	"new_task",
	"report_bug",
	"condense",
	"followup",
	"make_plan",
	"qna_response",
	"generate_report",
	"status_acknowledgment",
	"error_retry",
	"mistake_limit",
	"completion",
	"resume",
] as const

export type PresentationKind = (typeof PRESENTATION_KINDS)[number]

const APPROVAL_PRESENTATION_KINDS = new Set<PresentationKind>([
	"tool_approval",
	"command_approval",
	"browser_approval",
	"mcp_approval",
	"subagent_approval",
	"spawn_task_approval",
	"focus_chain_change",
])

/** Keep action controls visible while long interaction bodies scroll independently. */
function presentationContainerClassName(kind: PresentationKind): string | undefined {
	if (APPROVAL_PRESENTATION_KINDS.has(kind)) {
		return "max-h-[30vh] overflow-y-auto overscroll-x-contain"
	}
	if (kind === "make_plan") {
		return "max-h-[80vh] overflow-y-auto overscroll-x-contain"
	}
	return undefined
}

const RENDERERS = {
	tool_approval: ApprovalRenderer,
	command_approval: CommandRenderer,
	browser_approval: ApprovalRenderer,
	mcp_approval: ApprovalRenderer,
	subagent_approval: ApprovalRenderer,
	spawn_task_approval: ApprovalRenderer,
	focus_chain_change: FocusChainRenderer,
	new_task: ConversationRenderer,
	report_bug: ReportRenderer,
	condense: ConversationRenderer,
	followup: ConversationRenderer,
	make_plan: ConversationRenderer,
	qna_response: ConversationRenderer,
	generate_report: ReportRenderer,
	status_acknowledgment: ConversationRenderer,
	error_retry: ErrorRenderer,
	mistake_limit: ErrorRenderer,
	completion: CompletionRenderer,
	resume: ResumeRenderer,
} satisfies Record<PresentationKind, ComponentType<PresentationProps>>

/** Return whether a backend presentation identifier is registered. */
export function isPresentationKind(value: string): value is PresentationKind {
	return PRESENTATION_KINDS.some((kind) => kind === value)
}

/** Render one explicitly registered presentation without a generic fallback. */
export function renderPresentation(kind: PresentationKind, props: PresentationProps): ReactElement {
	const Renderer = RENDERERS[kind]
	return (
		<div className={presentationContainerClassName(kind)} data-testid={`presentation-${kind}`}>
			<Renderer {...props} />
		</div>
	)
}
