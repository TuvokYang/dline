import { PROVIDER_FAILURE_CLASSES, type ProviderFailureClass } from "@core/api/observability/provider-failure"

/** Failure classes shared by attempt usage and diagnostic contracts. */
export const USAGE_ERROR_CLASSES = PROVIDER_FAILURE_CLASSES
export type UsageErrorClass = ProviderFailureClass

/** The provider and model that served a request, as its handler reported them. */
export interface UsageServedModel {
    /** The Profile's provider ID, such as `anthropic` or `lmstudio`. */
    readonly provider: string
    /** The model ID the request was sent with. */
    readonly model: string
    /** Whether the Profile selected a free-form custom model ID. */
    readonly custom?: boolean
}
