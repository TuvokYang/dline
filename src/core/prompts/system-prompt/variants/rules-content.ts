import { getPrompt } from "../../i18n"
import { withoutPromptFragments } from "./conditional-content"
import type { SystemSectionContentConfig } from "./section-content-config"

const STANDARD_RULES = getPrompt("variants.standard", "rules")
const STANDARD_RULES_FOCUS_CONTRACT = getPrompt("variants.standard", "rulesFocusContract")
const LITE_RULES = getPrompt("variants.lite", "rules")
const LITE_RULES_YOLO_ASK_CLAUSE = getPrompt("variants.lite", "rulesYoloAskClause")

export function createStandardRules(config: SystemSectionContentConfig): string {
    return config.focusChainEnabled ? STANDARD_RULES : withoutPromptFragments(STANDARD_RULES, [STANDARD_RULES_FOCUS_CONTRACT])
}

export function createLiteRules(config: SystemSectionContentConfig): string {
    return config.yoloModeEnabled ? withoutPromptFragments(LITE_RULES, [LITE_RULES_YOLO_ASK_CLAUSE]) : LITE_RULES
}
