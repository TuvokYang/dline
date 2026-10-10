import { CLINE_ONBOARDING_MODELS } from "@/shared/cline/onboarding"
import { OnboardingModelGroup } from "@/shared/proto/dline/state"

/**
 * The model list offered during onboarding.
 *
 * A remote feature flag used to override this list entry by entry. Dline does
 * not take direction from that service, so the override and its cache were
 * removed and the local table is the only source.
 */
export function getClineOnboardingModels(): OnboardingModelGroup {
    return { models: [...CLINE_ONBOARDING_MODELS] }
}
