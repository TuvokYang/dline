import fs from "node:fs/promises"
import path from "node:path"

export interface CanonicalPathBoundaryOptions {
    readonly realpath?: (target: string) => Promise<string>
}

export interface CanonicalPathBoundaryReviewInput {
    readonly targets: readonly string[]
    readonly roots: readonly string[]
}

export type CanonicalPathBoundaryReview =
    | {
          readonly outcome: "confirmed"
          readonly canonicalTargets: readonly string[]
          readonly canonicalRoots: readonly string[]
          readonly isExternal: boolean
      }
    | {
          readonly outcome: "failed"
          readonly reason: "canonicalization_failed"
      }

function comparisonPath(value: string): string {
    const resolved = path.resolve(value)
    return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

/** Return whether a path is equal to or contained by one root. */
export function isPathInsideRoot(target: string, root: string): boolean {
    const relative = path.relative(comparisonPath(root), comparisonPath(target))
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

/**
 * Canonicalizes path boundaries after approval without reading target contents.
 *
 * Missing leaves are resolved through their nearest existing ancestor so create
 * operations can be reviewed before the destination exists. Any other realpath
 * failure is fail-closed because the caller cannot prove the approved boundary.
 */
export class CanonicalPathBoundary {
    private readonly realpath: (target: string) => Promise<string>

    constructor(options: CanonicalPathBoundaryOptions = {}) {
        this.realpath = options.realpath ?? fs.realpath
    }

    async review(input: CanonicalPathBoundaryReviewInput): Promise<CanonicalPathBoundaryReview> {
        try {
            const canonicalTargets = await Promise.all(input.targets.map((target) => this.canonicalize(target)))
            const canonicalRoots = await Promise.all(input.roots.map((root) => this.canonicalize(root)))
            return {
                outcome: "confirmed",
                canonicalTargets,
                canonicalRoots,
                isExternal: canonicalTargets.some((target) => !canonicalRoots.some((root) => isPathInsideRoot(target, root))),
            }
        } catch {
            return { outcome: "failed", reason: "canonicalization_failed" }
        }
    }

    private async canonicalize(target: string): Promise<string> {
        let candidate = path.resolve(target)
        const missingSegments: string[] = []
        while (true) {
            try {
                const canonical = await this.realpath(candidate)
                return path.resolve(canonical, ...missingSegments)
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code
                if (code !== "ENOENT" && code !== "ENOTDIR") throw error
                const parent = path.dirname(candidate)
                if (parent === candidate) throw error
                missingSegments.unshift(path.basename(candidate))
                candidate = parent
            }
        }
    }
}
