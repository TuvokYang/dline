import { getPrompt } from "../../i18n"
import { assemblePromptFragments } from "../assembly/prompt-fragment-assembler"
import type { SystemSectionContentConfig } from "./section-content-config"

const STANDARD_ACT_VS_PLAN = getPrompt("variants.standard", "actVsPlan")
const STANDARD_ACT_USER_DECISIONS = getPrompt("variants.standard", "actUserDecisions")
const STANDARD_ACT_USER_DECISIONS_YOLO = getPrompt("variants.standard", "actUserDecisionsYolo")
const STANDARD_ACT_SUBAGENT_DECISION_SOURCE = getPrompt("variants.standard", "actSubagentDecisionSource")
const STANDARD_ACT_WEB_DECISION_SOURCE = getPrompt("variants.standard", "actWebDecisionSource")
const LITE_ACT_VS_PLAN = getPrompt("variants.lite", "actVsPlan")
const LITE_ACT_PLAN_YOLO_ASK_TOOL = getPrompt("variants.lite", "actVsPlanYoloAskTool")
const LITE_ACT_PLAN_YOLO_QUESTION_GUIDANCE = getPrompt("variants.lite", "actVsPlanYoloQuestionGuidance")
const LITE_ACT_PLAN_YOLO_REPLACEMENT = getPrompt("variants.lite", "actVsPlanYoloReplacement")
const LITE_ACT_USER_DECISIONS = getPrompt("variants.lite", "actUserDecisions")
const LITE_ACT_USER_DECISIONS_YOLO = getPrompt("variants.lite", "actUserDecisionsYolo")

/** Subagent tools are exposed only outside a subagent run, matching the tool projection gate. */
function canDelegateToSubagents(config: SystemSectionContentConfig): boolean {
    return config.subagentsEnabled && !config.subagentRun
}

/** Either Web Search route lets the model look up how similar problems were solved. */
function canSearchWeb(config: SystemSectionContentConfig): boolean {
    return config.localWebSearchEnabled || config.serverWebSearchEnabled
}

/** Lists the extra fact sources ACT MODE may use, rendered only for capabilities exposed in this request. */
function createStandardDecisionSources(config: SystemSectionContentConfig): string {
    return [
        canDelegateToSubagents(config) ? STANDARD_ACT_SUBAGENT_DECISION_SOURCE : "",
        canSearchWeb(config) ? STANDARD_ACT_WEB_DECISION_SOURCE : "",
    ].join("")
}

export function createStandardActVsPlan(config: SystemSectionContentConfig): string {
    return assemblePromptFragments(STANDARD_ACT_VS_PLAN, {
        ACT_USER_DECISIONS: config.yoloModeEnabled ? STANDARD_ACT_USER_DECISIONS_YOLO : STANDARD_ACT_USER_DECISIONS,
        ACT_DECISION_SOURCES: createStandardDecisionSources(config),
    })
}

export function createLiteActVsPlan(config: SystemSectionContentConfig): string {
    return config.yoloModeEnabled
        ? LITE_ACT_VS_PLAN.replace(LITE_ACT_USER_DECISIONS, LITE_ACT_USER_DECISIONS_YOLO)
              .replace(LITE_ACT_PLAN_YOLO_ASK_TOOL, "")
              .replace(LITE_ACT_PLAN_YOLO_QUESTION_GUIDANCE, LITE_ACT_PLAN_YOLO_REPLACEMENT)
        : LITE_ACT_VS_PLAN
}
