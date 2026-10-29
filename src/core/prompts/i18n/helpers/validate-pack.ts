import type { LanguagePack, PromptPackIssue } from "./types"

/**
 * Compares a candidate language pack with a reference pack.
 *
 * @param language Candidate language identifier.
 * @param reference Reference language pack.
 * @param candidate Candidate language pack.
 * @returns Ordered missing and extra module/key issues.
 */
export function validatePromptPack(language: string, reference: LanguagePack, candidate: LanguagePack): PromptPackIssue[] {
    const issues: PromptPackIssue[] = []
    for (const [moduleName, referenceEntries] of Object.entries(reference)) {
        const candidateEntries = candidate[moduleName]
        if (!candidateEntries) {
            issues.push({ language, reason: "missing-module", module: moduleName })
            continue
        }
        for (const key of Object.keys(referenceEntries)) {
            if (!(key in candidateEntries)) {
                issues.push({ language, reason: "missing-key", module: moduleName, key })
            }
        }
        for (const key of Object.keys(candidateEntries)) {
            if (!(key in referenceEntries)) {
                issues.push({ language, reason: "extra-key", module: moduleName, key })
            }
        }
    }

    for (const moduleName of Object.keys(candidate)) {
        if (!(moduleName in reference)) {
            issues.push({ language, reason: "extra-module", module: moduleName })
        }
    }
    return issues
}
