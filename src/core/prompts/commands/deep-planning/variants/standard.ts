import { PromptProfile } from "../../../profiles/types"

export interface DeepPlanningVariantDescriptor {
    readonly id: PromptProfile
    readonly templateId: string
}

/** Standard deep-planning contract selected only by the explicit Prompt profile. */
export const STANDARD_DEEP_PLANNING_VARIANT: DeepPlanningVariantDescriptor = Object.freeze({
    id: PromptProfile.Standard,
    templateId: "deepPlanning5Step.main",
})
