import type { SemanticInputDocument } from "@shared/input-semantics/document"
import type { ClineAssistantContent } from "@shared/messages/content"
import type { ExplicitInstructionDeclaration } from "../../explicit-instructions/types"
import type { ProviderTurnApproval, ProviderTurnPlan } from "../../kernel"

export interface UserInputEnvelope {
	readonly kind: "user_input"
	/** What the user sees: the raw submission text, used for the chat row and history. */
	readonly text?: string
	readonly images?: readonly string[]
	readonly files?: readonly string[]
	readonly context?: string
	/** The submitted structure, kept so a later stage addresses nodes by identity. */
	readonly semanticInput?: SemanticInputDocument
	/** The admitted ordered projection sent to the provider, when admission ran. */
	readonly admittedText?: string
	/** Tools the user authorized by naming a command. */
	readonly authorizedTools?: readonly string[]
	/** Declarations the provider request registers before an authorized tool may run. */
	readonly explicitInstructions?: readonly ExplicitInstructionDeclaration[]
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
	readonly journalPayloadRefs: readonly string[]
	readonly turnId?: string
}

export interface ProviderPartialEnvelope {
	readonly kind: "provider_partial"
	readonly text: string
}

export interface ProviderFinalEnvelope {
	readonly kind: "provider_final"
	readonly text?: string
	readonly content?: readonly ClineAssistantContent[]
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
}

export interface ToolResultEnvelope {
	readonly kind: "tool_result"
	readonly blockId: string
	readonly content: string
	readonly failed?: boolean
}

export interface CompactionContextEnvelope {
	readonly kind: "compaction_context"
	readonly context: unknown
}

export interface CompactionResultEnvelope {
	readonly kind: "compaction_result"
	readonly result: unknown
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
