import { getPrompt, renderPrompt } from "../../prompts/i18n"

// Focus Chain prompts migrated to i18n layer for localization support.
// Each prompt is resolved via getPrompt() during module initialization.

const reminder = getPrompt("focusChain", "reminder")
const listInstructionsRecommended = getPrompt("focusChain", "listInstructionsRecommended")

export const FocusChainPrompts = {
	initial: getPrompt("focusChain", "initial"),
	progressUpdateWhenSupported: getPrompt("focusChain", "progressUpdateWhenSupported"),
	reminder,
	recommended: renderPrompt("focusChain", "recommended", {
		LIST_INSTRUCTIONS_RECOMMENDED: listInstructionsRecommended,
	}),
	planModeReminder: renderPrompt("focusChain", "planModeReminder", {
		REMINDER: reminder,
	}),
	completed: (totalItems: number) => renderPrompt("focusChain", "completed", { TOTAL_ITEMS: totalItems }),
	apiRequestCount: (count: number) =>
		renderPrompt("focusChain", "apiRequestCount", {
			API_REQUEST_COUNT: count,
			REMINDER: reminder,
		}),
	tamperingRejected: getPrompt("focusChain", "tamperingRejected"),
	titleRequired: getPrompt("focusChain", "titleRequired"),
	uncheckedItemRequired: getPrompt("focusChain", "uncheckedItemRequired"),
	skipOrderRejected: (examples: string) => renderPrompt("focusChain", "skipOrderRejected", { EXAMPLES: examples }),
	skipOrderWarning: getPrompt("focusChain", "skipOrderWarning"),
	itemMismatchRejected: (unmatchedItems: string, examples: string) =>
		renderPrompt("focusChain", "itemMismatchRejected", { UNMATCHED_ITEMS: unmatchedItems, EXAMPLES: examples }),
	inProgressMismatchRejected: (examples: string) =>
		renderPrompt("focusChain", "inProgressMismatchRejected", { EXAMPLES: examples }),
	allCompletedAlready: getPrompt("focusChain", "allCompletedAlready"),
	attemptCompletionBlocked: getPrompt("focusChain", "attemptCompletionBlocked"),
}
