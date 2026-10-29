import { PromptProfile } from "../../../profiles/types"
import type { DeepPlanningVariantDescriptor } from "./standard"

/** Lite deep-planning contract selected only by the explicit Prompt profile. */
export const LITE_DEEP_PLANNING_VARIANT: DeepPlanningVariantDescriptor = Object.freeze({
    id: PromptProfile.Lite,
    templateId: "deepPlanningGeneric.main",
})
