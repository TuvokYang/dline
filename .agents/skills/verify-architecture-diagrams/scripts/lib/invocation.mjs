// Invocation planning shared by the CLI and hermetic tests.

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const CODE_CONFORMANCE_SCOPE = "code-conformance"
const CODE_CONFORMANCE_MODULE = new URL("./checks-code-conformance.mjs", import.meta.url)

export function scopeSequence(scope, taskIds) {
    if (scope !== "all") return [scope]
    return [
        "workstream",
        ...taskIds
            .slice()
            .sort()
            .map((taskId) => `task:${taskId}`),
        "cross-task",
        CODE_CONFORMANCE_SCOPE,
    ]
}

function codeConformanceFinding(severity, message) {
    return {
        severity,
        attribution: severity === "tooling" ? "tooling" : "code",
        stage: "7",
        file: path.relative(process.cwd(), fileURLToPath(CODE_CONFORMANCE_MODULE)),
        line: null,
        rule: severity === "tooling" ? "code-conformance-tooling" : "code-conformance-pending",
        message,
    }
}

// TASK-11401 owns the stable aggregate hook. TASK-11403 supplies the optional
// implementation module without reopening CLI dispatch or scope ordering.
export async function runCodeConformanceScope(context) {
    const modulePath = fileURLToPath(CODE_CONFORMANCE_MODULE)
    if (!fs.existsSync(modulePath)) {
        return [
            codeConformanceFinding(
                "pending",
                "code conformance is reserved in the aggregate run and will be implemented by TASK-11403",
            ),
        ]
    }
    try {
        const module = await import(CODE_CONFORMANCE_MODULE.href)
        if (typeof module.checkCodeConformance !== "function") {
            return [codeConformanceFinding("tooling", "checks-code-conformance.mjs must export checkCodeConformance(context)")]
        }
        const findings = await module.checkCodeConformance(context)
        if (!Array.isArray(findings)) {
            return [codeConformanceFinding("tooling", "checkCodeConformance(context) must return an array of findings")]
        }
        return findings
    } catch (error) {
        return [codeConformanceFinding("tooling", `code conformance failed to initialize: ${error?.message ?? String(error)}`)]
    }
}

function findingKey(finding) {
    return [
        finding.severity ?? "",
        finding.attribution ?? "",
        finding.stage ?? "",
        finding.rule ?? "",
        finding.task ?? "",
        finding.file ?? "",
        finding.line ?? "",
        finding.message ?? "",
    ].join("|")
}

export function dedupeFindings(findings) {
    const seen = new Set()
    return findings.filter((finding) => {
        const key = findingKey(finding)
        if (seen.has(key)) return false
        seen.add(key)
        return true
    })
}
