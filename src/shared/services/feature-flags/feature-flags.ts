import type { FeatureFlagPayload } from "@/services/feature-flags/providers/IFeatureFlagsProvider"

/**
 * Experimental capability switches.
 *
 * These were once remote rollout flags. The flags that existed only to let an
 * upstream service steer this extension — model list sources, promotional
 * banners, onboarding overrides — have been removed, so what remains are local
 * switches for capabilities that are not yet ready to be on for everyone.
 *
 * The enum string values are the persisted identity of each switch and are also
 * what the environment variable names are derived from, so they must not be
 * changed casually.
 */
export enum ExperimentalFeatureFlag {
    WEBTOOLS = "webtools",
    WORKTREES = "worktree-exp",
    // Use the websocket mode for OpenAI native Responses API format
    OPENAI_RESPONSES_WEBSOCKET_MODE = "openai-responses-websocket-mode",
}

export const ExperimentalFeatureFlagDefaultValue: Partial<Record<ExperimentalFeatureFlag, FeatureFlagPayload>> = {
    [ExperimentalFeatureFlag.WEBTOOLS]: false,
    [ExperimentalFeatureFlag.WORKTREES]: false,
    [ExperimentalFeatureFlag.OPENAI_RESPONSES_WEBSOCKET_MODE]: false,
}

export const EXPERIMENTAL_FEATURE_FLAGS = Object.values(ExperimentalFeatureFlag)
