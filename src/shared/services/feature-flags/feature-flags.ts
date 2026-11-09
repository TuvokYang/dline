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
    // Checkpoint roots outside the open workspace; runtime wiring is intentionally deferred
    EXTERNAL_FILE_CHECKPOINTS = "checkpoint-external-files",
    // Folding a turn's activity rows in the chat; the rollout offers the setting, the user picks the level
    AGGRESSIVE_RENDERING = "aggressive_rendering",
    // Offers Away settings without enabling either user preference.
    AWAY_MODE = "away-mode",
}

export const ExperimentalFeatureFlagDefaultValue: Partial<Record<ExperimentalFeatureFlag, FeatureFlagPayload>> = {
    [ExperimentalFeatureFlag.WORKTREES]: false,
    [ExperimentalFeatureFlag.ACCOUNT]: false,
    [ExperimentalFeatureFlag.EXTERNAL_FILE_CHECKPOINTS]: false,
    [ExperimentalFeatureFlag.AGGRESSIVE_RENDERING]: false,
    [ExperimentalFeatureFlag.AWAY_MODE]: false,
}

/**
 * Flags selected exclusively by the remote service, for mutually exclusive rollouts.
 *
 * No current flag is mutually exclusive. Local overrides and development defaults
 * must never decide these flags; an absent remote answer is always off.
 */
export const REMOTE_ONLY_EXPERIMENTAL_FEATURE_FLAGS: ReadonlySet<ExperimentalFeatureFlag> = new Set()

export function experimentalFeatureFlagDefault(flag: ExperimentalFeatureFlag): FeatureFlagPayload {
    return REMOTE_ONLY_EXPERIMENTAL_FEATURE_FLAGS.has(flag) ? false : (ExperimentalFeatureFlagDefaultValue[flag] ?? false)
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
    ExperimentalFeatureFlag.EXTERNAL_FILE_CHECKPOINTS,
    ExperimentalFeatureFlag.AGGRESSIVE_RENDERING,
    ExperimentalFeatureFlag.AWAY_MODE,
]

export const EXPERIMENTAL_FEATURE_FLAGS = Object.values(ExperimentalFeatureFlag)
