import { LITE_DEEP_PLANNING_VARIANT } from "./lite"
import { type DeepPlanningVariantDescriptor, STANDARD_DEEP_PLANNING_VARIANT } from "./standard"

export { LITE_DEEP_PLANNING_VARIANT } from "./lite"
export type { DeepPlanningVariantDescriptor } from "./standard"
export { STANDARD_DEEP_PLANNING_VARIANT } from "./standard"

/** Complete provider-independent deep-planning variant set. */
export const DEEP_PLANNING_VARIANTS: readonly DeepPlanningVariantDescriptor[] = Object.freeze([
    STANDARD_DEEP_PLANNING_VARIANT,
    LITE_DEEP_PLANNING_VARIANT,
])
