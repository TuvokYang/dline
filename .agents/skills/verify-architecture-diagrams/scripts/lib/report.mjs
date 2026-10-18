// Report rendering. Findings are grouped by their attribution so a reader can tell
// a design defect from a record contradiction from a tool limitation.

const SEVERITY_ORDER = { blocking: 0, unverifiable: 1, "not-checked": 2, pending: 3 }

const ATTRIBUTION_TITLE = {
    diagram: "Blocking",
    record: "Blocking",
    tooling: "Tooling problem",
    unverifiable: "Unverifiable",
    "not-checked": "Not checked",
    pending: "Pending",
}

function label(finding) {
    const parts = []
    if (finding.stage) parts.push(`stage ${finding.stage}`)
    if (finding.rule) parts.push(finding.rule)
    if (finding.task) parts.push(finding.task)
    if (finding.file) parts.push(`${finding.file}${finding.line ? `:${finding.line}` : ""}`)
    return parts.join(" · ")
}

function group(findings) {
    const groups = {
        tooling: [],
        blocking: [],
        pending: [],
        unverifiable: [],
        "not-checked": [],
    }
    for (const finding of findings) {
        if (finding.attribution === "tooling") groups.tooling.push(finding)
        else if (finding.severity === "blocking") groups.blocking.push(finding)
        else if (finding.severity === "pending") groups.pending.push(finding)
        else if (finding.severity === "unverifiable") groups.unverifiable.push(finding)
        else groups["not-checked"].push(finding)
    }
    for (const key of Object.keys(groups)) {
        groups[key].sort((a, b) => {
            const stageDelta = Number(a.stage ?? 99) - Number(b.stage ?? 99)
            if (stageDelta !== 0) return stageDelta
            return Number(a.line ?? 0) - Number(b.line ?? 0)
        })
    }
    return groups
}

export function renderTextReport({ findings, summary }) {
    const groups = group(findings)
    const lines = []

    lines.push(`Workstream: ${summary.workstream}`)
    lines.push(`Scope: ${summary.scope}`)
    lines.push(`Diagrams: ${summary.diagramCount} (task diagrams: ${summary.taskDiagramCount})`)
    lines.push(`Tasks: ${summary.taskCount} (AST-gated: ${summary.astGatedCount})`)
    lines.push("")

    const tooling = groups.tooling
    lines.push("## Tooling problem")
    if (tooling.length === 0) {
        lines.push("None. This run's findings are design or record findings, not tool limitations.")
    } else {
        lines.push(`${tooling.length} problem(s). Design conclusions from this run are not trustworthy.`)
        for (const item of tooling) {
            lines.push(`- ${label(item)}`)
            lines.push(`  ${item.message}`)
            if (item.reproduce) lines.push(`  reproduce: ${item.reproduce}`)
        }
    }
    lines.push("")

    lines.push("## Blocking")
    if (groups.blocking.length === 0) {
        lines.push("None.")
    } else {
        for (const item of groups.blocking) {
            lines.push(`- [${item.attribution}] ${label(item)}`)
            lines.push(`  ${item.message}`)
        }
    }
    lines.push("")

    lines.push("## Pending")
    if (groups.pending.length === 0) {
        lines.push("None.")
    } else {
        for (const item of groups.pending) {
            lines.push(`- ${label(item)}`)
            lines.push(`  ${item.message}`)
        }
    }
    lines.push("")

    lines.push("## Unverifiable")
    if (groups.unverifiable.length === 0) {
        lines.push("None.")
    } else {
        lines.push("Counted as blocking: an undecidable relation is never treated as a pass.")
        for (const item of groups.unverifiable) {
            lines.push(`- ${label(item)}`)
            lines.push(`  ${item.message}`)
        }
    }
    lines.push("")

    lines.push("## Not checked")
    if (groups["not-checked"].length === 0) {
        lines.push("None.")
    } else {
        for (const item of groups["not-checked"]) {
            lines.push(`- ${label(item)}`)
            lines.push(`  ${item.message}`)
        }
    }
    lines.push("")

    if (summary.staleProjections.length > 0) {
        lines.push("## Stale status projections")
        lines.push("progress.md is authoritative; these projections were ignored rather than treated as defects.")
        for (const item of summary.staleProjections) {
            lines.push(
                `- ${item.task}: ${item.projection} says "${item.projected}", ${item.authoritativeFile} says "${item.authoritative}"`,
            )
        }
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

export function renderJsonReport({ findings, summary }) {
    return JSON.stringify(
        {
            workstream: summary.workstream,
            scope: summary.scope,
            exitCode: summary.exitCode,
            counts: {
                tooling: findings.filter((finding) => finding.attribution === "tooling").length,
                blocking: findings.filter((finding) => finding.severity === "blocking").length,
                unverifiable: findings.filter((finding) => finding.severity === "unverifiable").length,
                pending: findings.filter((finding) => finding.severity === "pending").length,
                notChecked: findings.filter((finding) => finding.severity === "not-checked").length,
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
