/**
 * Identity of the running build, reported with diagnostics.
 *
 * A released bundle is minified and its source map never ships, so a stack
 * frame from a bug report is unreadable on its own. The build id is what lets
 * a maintainer pick the archived map that can decode it; without the id there
 * is no safe way to choose, and guessing with the wrong map produces
 * confidently wrong file names and line numbers.
 */

/** Value used when a build did not stamp an id, for example a dev build. */
export const UNKNOWN_BUILD_ID = "unknown"

export interface BuildIdentity {
    readonly buildId: string
    /** False when the id is unknown, so a reader does not trust symbolication. */
    readonly symbolicatable: boolean
}

/**
 * Interpret a raw build id string.
 *
 * Separate from the reader so the decision can be tested without depending on
 * how the id reaches the process.
 */
export function interpretBuildId(rawBuildId: string | undefined): BuildIdentity {
    const buildId = rawBuildId?.trim()
    if (!buildId || buildId === UNKNOWN_BUILD_ID) {
        return { buildId: UNKNOWN_BUILD_ID, symbolicatable: false }
    }
    // A dev build is readable without a map because it is not minified, but it
    // still has no archived map, so it is not symbolicatable in this sense.
    return { buildId, symbolicatable: buildId !== "dev" }
}

/**
 * Read the id baked in at bundle time.
 *
 * The lookup is written as the exact expression `process.env.DLINE_BUILD_ID`
 * because esbuild `define` substitutes that expression textually. Capturing
 * `process.env` into a variable first — including via a default parameter —
 * defeats the substitution and makes every shipped build report `unknown`.
 */
export function readBuildIdentity(): BuildIdentity {
    return interpretBuildId(process.env.DLINE_BUILD_ID)
}
