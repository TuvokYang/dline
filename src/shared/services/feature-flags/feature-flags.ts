import type { FeatureFlagPayload } from "@/services/feature-flags/providers/IFeatureFlagsProvider"

/**
 * Rollout switches for capabilities that are not yet offered to everyone.
 *
 * A switch decides whether a capability is offered on this device: while it is
 * on, Settings shows the capability's own toggle or configuration. Whether the
 * capability is then in use is the user's separate choice, kept in a regular
 * setting (see `DlineFeatureSettings`). A capability that is ready for everyone
 * has no switch here.
 *
 * The enum string values are the identity the Dline feature service answers by
 * and what the environment variable names are derived from, so they must not be
 * changed casually.
 */
export enum ExperimentalFeatureFlag {
    // Git worktree management for running parallel tasks
    WORKTREES = "worktree-exp",
    // Account sign-in and the account view; the account service is not ready for everyone
    ACCOUNT = "account",
}

export const ExperimentalFeatureFlagDefaultValue: Partial<Record<ExperimentalFeatureFlag, FeatureFlagPayload>> = {
    [ExperimentalFeatureFlag.WORKTREES]: false,
    [ExperimentalFeatureFlag.ACCOUNT]: false,
}

/**
 * Switches a development build turns on by default.
 *
 * Kept per switch rather than applied to all: turning every switch on in
 * development bundles would also change what the E2E runs, which use those
 * bundles, exercise.
 */
export const ExperimentalFeatureFlagDevelopmentDefault: Partial<Record<ExperimentalFeatureFlag, boolean>> = {
    [ExperimentalFeatureFlag.ACCOUNT]: true,
}

/**
 * Switches the Dline feature service may roll out.
 *
 * The service answers only for these; anything else it sends is ignored, so a
 * server mistake cannot switch on a capability that was never meant for
 * remote rollout.
 */
export const REMOTE_ROLLOUT_FEATURE_FLAGS: readonly ExperimentalFeatureFlag[] = [
    ExperimentalFeatureFlag.ACCOUNT,
    ExperimentalFeatureFlag.WORKTREES,
]

export const EXPERIMENTAL_FEATURE_FLAGS = Object.values(ExperimentalFeatureFlag)
