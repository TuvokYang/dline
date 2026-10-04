import type { SemanticInputDocument } from "@shared/input-semantics/document"
import type { ClineAssistantContent, ClineStorageMessage } from "@shared/messages/content"
import type { ClineMessageModelInfo } from "@shared/messages/metrics"
import type { ExplicitInstructionDeclaration } from "../../explicit-instructions/types"
import type {
	JournalWatermark,
	ProviderTurnApproval,
	ProviderTurnPlan,
	ToolTerminalPhase,
	TurnContinuationReason,
} from "../../kernel"

/**
 * A lifecycle command the user placed, carried with the input that named it.
 *
 * It travels with the accepted input rather than being handed to its owner at
 * admission, so a submission the kernel refuses - or a round a stop releases -
 * never carries it out, and a restart finds it where the input left it.
 */
export interface LifecycleCommand {
	readonly commandId: string
	/** Content addressed to the command itself, never sent to the model as prose. */
	readonly premessage: string
}

export interface UserInputEnvelope {
	readonly kind: "user_input"
	/** What the user sees: the raw submission text, used for the chat row and history. */
	readonly text?: string
	readonly images?: readonly string[]
	readonly files?: readonly string[]
	readonly activeQuote?: string
	readonly context?: string
	/** The submitted structure, kept so a later stage addresses nodes by identity. */
	readonly semanticInput?: SemanticInputDocument
	/** The admitted ordered projection sent to the provider, when admission ran. */
	readonly admittedText?: string
	/** Tools the user authorized by naming a command. */
	readonly authorizedTools?: readonly string[]
	/** Declarations the provider request registers before an authorized tool may run. */
	readonly explicitInstructions?: readonly ExplicitInstructionDeclaration[]
	/** The lifecycle command this input carries out before the round that admits it. */
	readonly lifecycle?: LifecycleCommand
}

export interface DialogDraftEnvelope {
	readonly kind: "dialog_draft"
	readonly text: string
	readonly images: readonly string[]
	readonly files: readonly string[]
	/**
	 * The structure this reply was composed as, when the client submitted one.
	 *
	 * Persisted with the draft so a recovered interaction keeps the structure the
	 * user confirmed instead of re-deriving commands and mentions from `text`.
	 */
	readonly semanticInput?: SemanticInputDocument
}

export interface DialogSelectionEnvelope {
	readonly kind: "dialog_selection"
	readonly values: readonly string[]
}

export interface DialogPresentationEnvelope {
	readonly kind: "dialog_presentation"
	readonly presentationKind: string
	readonly body: string
	readonly existingTs?: number
	readonly completionId?: string
}

export interface ProviderDraftEnvelope {
	readonly kind: "provider_draft"
	readonly admittedEntryIds: readonly string[]
	readonly inputPayloadRefs: readonly string[]
	/**
	 * The journal position the round's conversation was composed through.
	 *
	 * The journal only appends, so the projection through this position never
	 * changes: a retried or recovered request replays the same messages, and the
	 * draft stays the same size however long the conversation grows.
	 */
	readonly journalThrough?: JournalWatermark
	/** @deprecated Written by drafts before `journalThrough`; read only to replay them. */
	readonly journalPayloadRefs?: readonly string[]
	readonly turnId?: string
	/** Present when the kernel opened this round instead of the user; see TurnContinuationEnvelope. */
	readonly continuation?: TurnContinuationReason
}

/**
 * Why a round the user did not ask for was opened.
 *
 * Kept as its own kind so replay can tell this system prompt from user-authored
 * input, and so a continued round states its reason in the conversation rather
 * than silently repeating the previous request.
 */
export interface TurnContinuationEnvelope {
	readonly kind: "turn_continuation"
	readonly reason: TurnContinuationReason
	readonly text: string
}

/**
 * Results of work that finished while the model was busy elsewhere.
 *
 * A background command or subagent completes on its own schedule, so the only
 * way the model learns the outcome is a round that carries it. Kept as its own
 * kind because it is reported once: replay must show it where it was delivered
 * rather than re-deriving it from whatever the background state looks like now.
 */
export interface BackgroundResultsEnvelope {
	readonly kind: "background_results"
	readonly text: string
}

/** A least-authority message copied between two live task payload stores. */
export interface CoTaskMessageEnvelope {
	readonly kind: "cotask_message"
	readonly text: string
	readonly source: {
		readonly taskId: string
		readonly taskIncarnationId: string
		readonly principalId: string
		readonly deliveryId: string
	}
}

export interface ProviderPartialEnvelope {
	readonly kind: "provider_partial"
	readonly text: string
}

/**
 * A reply the user stopped before it finished.
 *
 * Its reasoning and prose stay in the conversation, closed by an interruption
 * notice, so the next request continues from what the model already said
 * instead of silently losing it. It plans no turn: a call the model was still
 * writing never ran.
 */
export interface ProviderInterruptedEnvelope {
	readonly kind: "provider_interrupted"
	readonly content: readonly ClineAssistantContent[]
}

export interface ProviderFinalEnvelope {
	readonly kind: "provider_final"
	readonly text?: string
	readonly content?: readonly ClineAssistantContent[]
	/**
	 * The model that wrote this reply.
	 *
	 * A request to a different model projects this turn as foreign history, so
	 * the producer must survive a restart with the reply. Absent for replies
	 * written before it was recorded; those are treated as the target's own.
	 */
	readonly modelInfo?: ClineMessageModelInfo
	readonly turnPlan: ProviderTurnPlan
}

export interface ProviderBlockOutput {
	readonly blockId: string
	readonly attempt: string
	readonly index: number
	readonly lanes: readonly string[]
	readonly turnEnding: boolean
	readonly invocation: ToolInvocationEnvelope
	readonly approval: ProviderTurnApproval
}

export interface ToolInvocationEnvelope {
	readonly kind: "tool_invocation"
	readonly toolName: string
	readonly input: Readonly<Record<string, unknown>>
	readonly functionId: string
	readonly dlineTid: string
	readonly presentationId: number
	readonly isNativeToolCall: boolean
	readonly signature?: string
	/**
	 * Set when the provider boundary kept this call out of the recorded
	 * conversation as a tool call, so its result must return as prose rather
	 * than pair with a call id the provider never issued. Absent means paired.
	 */
	readonly resultReplay?: "text"
}

export interface ToolResultEnvelope {
	readonly kind: "tool_result"
	readonly blockId: string
	readonly content: string
	readonly failed?: boolean
}

export interface ToolTerminalManifestEnvelope {
	readonly kind: "tool_terminal_manifest"
	readonly turnId: string
	readonly results: readonly {
		readonly blockId: string
		readonly phase: ToolTerminalPhase
		readonly content: string
		readonly failed?: boolean
		readonly feedbackRef?: string
	}[]
	/** Raw result and approval-feedback payloads replaced by this ordered projection. */
	readonly supersededPayloadRefs: readonly string[]
}

/**
 * Who asked for a compaction, which decides whether the user reviews it.
 *
 * A summary the user asked for is shown before it replaces anything, because
 * it is their conversation being condensed on their word; an automatic or
 * transition summary lands on its own, since nobody is waiting to confirm it.
 */
export type CompactionTrigger = "automatic" | "manual" | "transition"

/**
 * What replaces the span: a summary the model writes, or a fixed notice.
 *
 * Truncation is the user's last resort once automatic compaction failed: it
 * drops the span without asking the provider that just failed to summarize it.
 */
export type CompactionMode = "summarize" | "force_truncate"

export interface CompactionContextEnvelope {
	readonly kind: "compaction_context"
	/** Absent in contexts written before modes were recorded; treated as summarize. */
	readonly mode?: CompactionMode
	/** Journal span the request summarizes; landing replaces exactly this span. */
	readonly span?: { readonly from: JournalWatermark; readonly to: JournalWatermark }
	/** The user's reply the span ends on, which landing replays after the summary instead of condensing. */
	readonly continuation?: CompactionContinuation
	/** Replies inside the span that a summary covering only the oldest turns may have to land on. */
	readonly replies?: readonly CompactionReplyBoundary[]
	/** Absent in contexts written before triggers were recorded; treated as automatic. */
	readonly trigger?: CompactionTrigger
	readonly context: unknown
}

export interface CompactionResultEnvelope {
	readonly kind: "compaction_result"
	readonly result: unknown
}

/**
 * The summary that now stands for a condensed span of the conversation.
 *
 * Kept as its own kind because the span it replaced is still in the journal:
 * only this entry explains why those messages stopped reaching the provider,
 * so a replay shows the compaction where it happened instead of inferring it.
 */
export interface CompactionSummaryEnvelope {
	readonly kind: "compaction_summary"
	readonly compactionId: string
	readonly text: string
	/**
	 * User input the condensed span carried that the model has not answered.
	 *
	 * A reply written into a tool result belongs to the protected continuation
	 * (WS-010 §2), yet the result must stay paired with its call, so both are
	 * condensed and the reply is replayed after the summary as ordinary input.
	 */
	readonly continuation?: CompactionContinuation
}

/** The user-authored part of a condensed reply, replayed verbatim after the summary. */
export interface CompactionContinuation {
	readonly text: string
	readonly images?: readonly string[]
	readonly files?: readonly string[]
}

/**
 * A user's reply inside a condensed span, located by the call it answers.
 *
 * A summary that stops right after that call would land without the call's
 * result, which then answers nothing. Landing takes the reply as well and
 * replays it after the summary, as it does for the reply a whole span ends on.
 */
export interface CompactionReplyBoundary {
	/** Journal position of the call the reply answers. */
	readonly callSeq: number
	/** Journal position of the reply itself. */
	readonly replySeq: number
	readonly continuation: CompactionContinuation
}

/**
 * Dynamic environment snapshot composed for one provider round.
 *
 * Kept as its own kind so the conversation replay can tell an environment
 * block from user-authored input, and so the latest snapshot can be treated
 * as transient context when measuring the window.
 */
export interface EnvironmentDetailsEnvelope {
	readonly kind: "environment_details"
	readonly text: string
}

/**
 * A provider message written before the journal existed, carried in as stored.
 *
 * Tasks from before the journal kept their conversation only in
 * `api_conversation_history.jsonl`. Each message is replayed verbatim, because
 * no runtime payload can reconstruct what an older build sent.
 */
export interface LegacyMessageEnvelope {
	readonly kind: "legacy_message"
	readonly message: ClineStorageMessage
}

export interface TaskHandoffEnvelope {
	readonly kind: "task_handoff"
	readonly context: string
	readonly source: { readonly functionId: string; readonly dlineTid: string }
	readonly initialUserContent: readonly unknown[]
	readonly taskSettings: {
		readonly mode: "plan" | "act"
		readonly planModeProfileId?: string
		readonly planModeProfile?: string
		readonly actModeProfileId?: string
		readonly actModeProfile?: string
	}
}
