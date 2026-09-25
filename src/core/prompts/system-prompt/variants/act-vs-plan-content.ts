import { getPrompt } from "../../i18n"
import type { SystemSectionContentConfig } from "./section-content-config"

const STANDARD_ACT_VS_PLAN = getPrompt("variants.standard", "actVsPlan")
const LITE_ACT_VS_PLAN = getPrompt("variants.lite", "actVsPlan")
const LITE_ACT_PLAN_YOLO_ASK_TOOL = getPrompt("variants.lite", "actVsPlanYoloAskTool")
const LITE_ACT_PLAN_YOLO_QUESTION_GUIDANCE = getPrompt("variants.lite", "actVsPlanYoloQuestionGuidance")
const LITE_ACT_PLAN_YOLO_REPLACEMENT = getPrompt("variants.lite", "actVsPlanYoloReplacement")

export function createStandardActVsPlan(): string {
	return STANDARD_ACT_VS_PLAN
}

export function createLiteActVsPlan(config: SystemSectionContentConfig): string {
	return config.yoloModeEnabled
		? LITE_ACT_VS_PLAN.replace(LITE_ACT_PLAN_YOLO_ASK_TOOL, "").replace(
				LITE_ACT_PLAN_YOLO_QUESTION_GUIDANCE,
				LITE_ACT_PLAN_YOLO_REPLACEMENT,
			)
		: LITE_ACT_VS_PLAN
}
