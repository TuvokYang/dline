import { summarizeTask } from "@core/prompts/contextManagement"
import { PromptProfile } from "@core/prompts/profiles/types"

/** Prompt facts the summarize instruction depends on, resolved for the request it rides on. */
export interface CompactionInstructionFacts {
	readonly cwd: string
	readonly profile: PromptProfile
	readonly focusChain?: { readonly enabled: boolean }
	readonly multiRoot: boolean
	/** The window budget block the model must respect; empty when none is stated. */
	readonly budgetGuidance?: string
}

/**
 * Render the summarize instruction appended after the compacted conversation.
 *
 * Focus-chain guidance only exists in the Standard profile, so a Lite request
 * must not ask the model to carry a focus chain it was never told to keep.
 */
export function renderCompactionInstruction(facts: CompactionInstructionFacts): string {
	const focusChain = facts.profile === PromptProfile.Standard ? facts.focusChain : undefined
	return summarizeTask(focusChain, facts.cwd, facts.multiRoot, facts.budgetGuidance ?? "")
}
