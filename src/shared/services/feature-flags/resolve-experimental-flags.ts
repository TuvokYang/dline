import { envFlagEnabled } from "@/shared/env"
import { EXPERIMENTAL_FEATURE_FLAGS, ExperimentalFeatureFlag, ExperimentalFeatureFlagDefaultValue } from "./feature-flags"

/**
 * Resolves the experimental switches from the local environment.
 *
 * The switches used to be answered by a remote flag service. They are now
 * resolved here, in order of precedence:
 *
 *   1. `DLINE_EXPERIMENTAL_<FLAG>` when set to a recognised value
 *   2. `IS_DEV`, which turns every switch on
 *   3. the static default
 *
 * This module is deliberately free of IO so the precedence can be tested by
 * passing an environment object rather than mutating `process.env`.
 */

const ENV_PREFIX = "DLINE_EXPERIMENTAL_"
const DEV_ENV_VAR = "IS_DEV"

export type EnvironmentSource = Readonly<Record<string, string | undefined>>

/**
 * Derives the variable name from the flag value: uppercase, `-` and `_`
 * collapsed to `_`, prefixed.
 *
 * Deriving rather than tabulating keeps the name tied to the flag; a lookup
 * table would be a second place to forget when a flag is added.
 */
export function environmentVariableNameFor(flag: ExperimentalFeatureFlag): string {
    return `${ENV_PREFIX}${flag.replace(/[-_]+/g, "_").toUpperCase()}`
}

/**
 * Reads one switch. An unset or unrecognised variable falls through to the next
 * source rather than being treated as `false`, so a typo cannot silently
 * disable a switch that `IS_DEV` or the default would have enabled.
 */
export function resolveExperimentalFlag(flag: ExperimentalFeatureFlag, env: EnvironmentSource): boolean {
    const explicit = readBooleanEnv(env[environmentVariableNameFor(flag)])
    if (explicit !== undefined) {
        return explicit
    }

    if (envFlagEnabled(env[DEV_ENV_VAR])) {
        return true
    }

    return ExperimentalFeatureFlagDefaultValue[flag] === true
}

export function resolveExperimentalFlags(env: EnvironmentSource): Record<ExperimentalFeatureFlag, boolean> {
    const resolved = {} as Record<ExperimentalFeatureFlag, boolean>
    for (const flag of EXPERIMENTAL_FEATURE_FLAGS) {
        resolved[flag] = resolveExperimentalFlag(flag, env)
    }
    return resolved
}

/**
 * `envFlagEnabled` cannot express "explicitly off": it maps both `"false"` and
 * an unset variable to `false`. Disabling a switch under `IS_DEV` requires
 * telling those apart, so the negative spellings are recognised here and
 * anything else is reported as absent.
 */
function readBooleanEnv(rawValue: string | undefined): boolean | undefined {
    if (rawValue === undefined) {
        return undefined
    }

    if (envFlagEnabled(rawValue)) {
        return true
    }

    const normalized = rawValue.trim().toLowerCase()
    if (normalized === "false" || normalized === "0") {
        return false
    }

    return undefined
}
