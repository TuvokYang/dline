// Report rendering. Exit codes and verdicts are orthogonal: warnings can keep exit 0
// while making the run explicitly incomplete.

const SEVERITY_ORDER = { tooling: 0, blocking: 1, unverifiable: 2, warning: 3, pending: 4, "not-checked": 5, "not-applicable": 6 }
const GROUP_ORDER = ["tooling", "blocking", "warning", "pending", "unverifiable", "not-checked", "not-applicable"]
const TITLES = {
    tooling: "Tooling problem",
    blocking: "Blocking",
    warning: "Warning",
    pending: "Pending",
    unverifiable: "Unverifiable",
    "not-checked": "Not checked",
    "not-applicable": "Not applicable",
}

function label(finding) {
    const parts = []
    if (finding.stage) parts.push(`stage ${finding.stage}`)
    if (finding.rule) parts.push(finding.rule)
    if (finding.task) parts.push(finding.task)
    if (finding.file) parts.push(`${finding.file}${finding.line ? `:${finding.line}` : ""}`)
    return parts.join(" · ")
}

function bucketOf(finding) {
    if (finding.attribution === "tooling" || finding.severity === "tooling") return "tooling"
    if (GROUP_ORDER.includes(finding.severity)) return finding.severity
    return "not-checked"
}

function group(findings) {
    const groups = Object.fromEntries(GROUP_ORDER.map((key) => [key, []]))
    for (const finding of findings) groups[bucketOf(finding)].push(finding)
    for (const entries of Object.values(groups))
        entries.sort((a, b) => Number(a.stage ?? 99) - Number(b.stage ?? 99) || Number(a.line ?? 0) - Number(b.line ?? 0))
    return groups
}

export function renderTextReport({ findings, summary }) {
    const groups = group(findings)
    const coverage = summary.coverage ?? {
        mode: summary.scope === "all" ? "delivery" : "diagnostic",
        complete: false,
        missingScopes: [],
    }
    const selfTest = summary.evidence?.selfTest ?? { status: "not_run", message: null }
    const lines = [
        `Workstream: ${summary.workstream}`,
        `Scope: ${summary.scope}`,
        `Verdict: ${summary.verdict}`,
        `Coverage: ${coverage.complete ? "complete delivery evidence" : `${coverage.mode} only; incomplete`}`,
        `Self-test: ${selfTest.status}${selfTest.message ? ` (${selfTest.message})` : ""}`,
        `Diagrams: ${summary.diagramCount} (task diagrams: ${summary.taskDiagramCount})`,
        `Tasks: ${summary.taskCount} (AST-gated: ${summary.astGatedCount})`,
        "",
    ]
    for (const key of GROUP_ORDER) {
        lines.push(`## ${TITLES[key]}`)
        const entries = groups[key]
        if (entries.length === 0) lines.push("None.")
        else {
            if (key === "tooling")
                lines.push(`${entries.length} problem(s). Design conclusions from this run are not trustworthy.`)
            if (key === "unverifiable") lines.push("Counted as blocking: an undecidable relation is never treated as a pass.")
            for (const item of entries) {
                lines.push(`- ${key === "blocking" ? `[${item.attribution}] ` : ""}${label(item)}`)
                lines.push(`  ${item.message}`)
                if (item.reproduce) lines.push(`  reproduce: ${item.reproduce}`)
            }
        }
        lines.push("")
    }
    if (summary.staleProjections.length > 0) {
        lines.push("## Stale status projections")
        lines.push("progress.md is authoritative; these projections were ignored rather than treated as defects.")
        for (const item of summary.staleProjections)
            lines.push(
                `- ${item.task}: ${item.projection} says "${item.projected}", ${item.authoritativeFile} says "${item.authoritative}"`,
            )
        lines.push("")
    }
    lines.push(`Exit: ${summary.exitCode} (${describeExit(summary.exitCode)})`)
    return lines.join("\n")
}

export function describeExit(code) {
    if (code === 2) return "tooling problem; design verdict withheld"
    if (code === 1) return "blocking or unverifiable findings"
    return "no blocking, unverifiable or tooling findings"
}

export function computeExitCode(findings) {
    if (findings.some((finding) => finding.attribution === "tooling" || finding.severity === "tooling")) return 2
    if (findings.some((finding) => finding.severity === "blocking" || finding.severity === "unverifiable")) return 1
    return 0
}

export function computeVerdict(findings, { applicable = true, coverageComplete = true } = {}) {
    const exitCode = computeExitCode(findings)
    if (exitCode === 2) return "tooling_error"
    if (exitCode === 1) return "failed"
    if (!applicable) return "not_applicable"
    if (!coverageComplete) return "incomplete"
    if (findings.some((finding) => ["warning", "pending", "not-checked", "not-applicable"].includes(finding.severity)))
        return "incomplete"
    return "conformant"
}

export function renderJsonReport({ findings, summary }) {
    const counts = Object.fromEntries(
        GROUP_ORDER.map((key) => [key, findings.filter((finding) => bucketOf(finding) === key).length]),
    )
    const coverage = summary.coverage ?? {
        mode: summary.scope === "all" ? "delivery" : "diagnostic",
        complete: false,
        requiredScopes: [],
        executedScopes: [],
        missingScopes: [],
    }
    const evidence = summary.evidence ?? { selfTest: { status: "not_run", message: null } }
    return JSON.stringify(
        {
            schemaVersion: 1,
            workstream: summary.workstream,
            scope: summary.scope,
            applicable: summary.applicable ?? true,
            verdict: summary.verdict,
            exitCode: summary.exitCode,
            coverage,
            evidence: {
                selfTest: evidence.selfTest,
                metrics: {
                    diagramCount: summary.diagramCount,
                    taskDiagramCount: summary.taskDiagramCount,
                    taskCount: summary.taskCount,
                    astGatedCount: summary.astGatedCount,
                },
            },
            counts: {
                tooling: counts.tooling,
                blocking: counts.blocking,
                warning: counts.warning,
                unverifiable: counts.unverifiable,
                pending: counts.pending,
                notChecked: counts["not-checked"],
                notApplicable: counts["not-applicable"],
            },
            staleProjections: summary.staleProjections,
            findings: findings
                .slice()
                .sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9))
                .map((finding) => ({
                    severity: finding.severity,
                    attribution: finding.attribution,
                    stage: finding.stage ?? null,
                    rule: finding.rule ?? null,
                    file: finding.file ?? null,
                    line: finding.line ?? null,
                    task: finding.task ?? null,
                    diagram: finding.diagram ?? null,
                    message: finding.message,
                })),
        },
        null,
        2,
    )
}
