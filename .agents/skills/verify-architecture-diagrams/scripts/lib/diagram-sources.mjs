// Inspection subjects come from diagram bindings, never from a source-edit registry.
import fs from "node:fs"
import path from "node:path"
import { importsInScriptRegions, resolveScriptRegion } from "./script-regions.mjs"
import { languageForPath } from "./tree-sitter-runtime.mjs"

const canonical = (value) =>
    String(value ?? "")
        .normalize("NFKC")
        .replaceAll("\\", "/")
        .replace(/^\.\//, "")
        .toLowerCase()
const excludedDirectories = new Set([".git", "node_modules", "__tests__", "__fixtures__", "dist", "build", "out", "tmp"])
const testFile = /\.(?:test|spec)\.[cm]?[jt]sx?$/

function definitionFinding(record, message) {
    return {
        severity: "unverifiable",
        attribution: "record",
        stage: "7",
        rule: "diagram-symbol-unverifiable",
        message,
        file: record.diagram.file,
        line: null,
        task: record.task?.id ?? null,
        diagram: record.task?.id ?? null,
    }
}

export function expandDiagramSources(records, repoRoot) {
    const expanded = []
    const root = path.resolve(repoRoot)
    for (const record of records) {
        const absolute = path.resolve(root, record.artifact.path)
        const relative = path.relative(root, absolute)
        if (relative.startsWith("..") || path.isAbsolute(relative) || !fs.existsSync(absolute)) {
            expanded.push(record)
            continue
        }
        if (!fs.statSync(absolute).isDirectory() || record.artifact.symbol) {
            expanded.push(record)
            continue
        }
        // A support directory is an interface boundary, not an implicit recursive input.
        // Concrete endpoints needed for a proof must still name their actual source file.
        if (record.artifact.inspection === "support") continue
        const visit = (directory) => {
            for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
                const file = path.join(directory, entry.name)
                if (entry.isDirectory() && !excludedDirectories.has(entry.name)) visit(file)
                if (!entry.isFile() || testFile.test(entry.name) || !languageForPath(file)) continue
                expanded.push({
                    ...record,
                    artifact: { ...record.artifact, path: path.relative(root, file).replaceAll("\\", "/") },
                })
            }
        }
        visit(absolute)
    }
    return expanded
}

export function bindDiagramSources(records, snapshot) {
    const findings = []
    const subjects = []
    const taskBoundPaths = new Set(records.filter((record) => record.task).map((record) => canonical(record.artifact.path)))
    const seen = new Set()
    for (const record of records) {
        const { artifact, task } = record
        if (!languageForPath(artifact.path) || artifact.expectation === "absent") continue
        if (!task && taskBoundPaths.has(canonical(artifact.path))) continue
        const key = [task?.id ?? "", canonical(artifact.path), artifact.symbol ?? "", artifact.inspection ?? "subject"].join("|")
        if (seen.has(key)) continue
        seen.add(key)
        const root = [...(snapshot.scriptModels ?? [])].find(([file]) => canonical(file) === canonical(artifact.path))?.[1]
        let ranges = null
        if (artifact.symbol) {
            const selected = resolveScriptRegion(root, { symbol: artifact.symbol })
            if (selected.state !== "resolved") {
                findings.push(
                    definitionFinding(
                        record,
                        `diagram binding ${artifact.path}#${artifact.symbol} cannot be located: ${selected.reason}`,
                    ),
                )
                continue
            }
            ranges = [selected]
        }
        // Support endpoints retain existence, definition, identity, edge and writer checks.
        // Only their unrelated implementation dependencies are outside the audit boundary.
        if (artifact.inspection !== "support") subjects.push({ file: artifact.path, taskId: task?.id ?? null, ranges })
    }
    const imports = subjects.flatMap((subject) => {
        const edges =
            subject.ranges === null
                ? snapshot.imports.filter((edge) => canonical(edge.importer) === canonical(subject.file))
                : importsInScriptRegions(snapshot, subject.file, subject.ranges)
        return edges.map((edge) => ({ ...edge, taskId: subject.taskId }))
    })
    return { findings, subjects, imports }
}
