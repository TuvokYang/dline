import { getPrompt } from "../../i18n"
import { withoutPromptFragments } from "./conditional-content"
import type { SystemSectionContentConfig } from "./section-content-config"

const STANDARD_OBJECTIVE = getPrompt("objective", "standard")
const STANDARD_OBJECTIVE_FOCUS_LINE = getPrompt("objective", "standardFocusLine")
const LITE_OBJECTIVE = getPrompt("objective", "lite")

export function createStandardObjective(config: SystemSectionContentConfig): string {
	return config.focusChainEnabled
		? STANDARD_OBJECTIVE
		: withoutPromptFragments(STANDARD_OBJECTIVE, [STANDARD_OBJECTIVE_FOCUS_LINE])
}

export function createLiteObjective(): string {
	return LITE_OBJECTIVE
}
