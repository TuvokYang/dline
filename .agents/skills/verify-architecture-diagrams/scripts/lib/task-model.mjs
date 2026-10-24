// Task-side model: gates derived from goals.yaml, progress.md and plan.md.
// These gates decide whether an AST check is meaningful, so they must never be
// inferred from anything the Workstream rules do not define.

import fs from "node:fs"
import path from "node:path"

import { parseArchitectureEvidence } from "./evidence-model.mjs"
import { extractMermaidBlocks, parseFlowchart } from "./mermaid-parse.mjs"
import { parseYamlLite, readFrontmatterFile, YamlLiteError } from "./yaml-lite.mjs"

const COMPLETED = "completed"
const COMPLETED_STATUSES_FOR_AST = new Set([COMPLETED])

function asArray(value) {
    if (value === null || value === undefined) return []
    return Array.isArray(value) ? value : [value]
}

function text(value) {
    return typeof value === "string" ? value.trim() : ""
}

// Reads the Workstream plan's Task Graph into ordered task records.
export function readPlanGraph(content) {
    const lines = content.split(/\r?\n/)
    const headerIndex = lines.findIndex((line) => /^\|\s*Task\s*\|\s*Goal Contract\s*\|/i.test(line.trim()))
    if (headerIndex === -1) return { tasks: [], error: "Task Graph table not found" }
    const columns = lines[headerIndex]
        .trim()
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim().toLowerCase())
    const indexOf = (name) => columns.findIndex((column) => column === name)
    const taskColumn = indexOf("task")
    const dependsColumn = indexOf("depends on")
    const modeColumn = indexOf("execution mode")
    if (taskColumn === -1 || dependsColumn === -1) {
        return { tasks: [], error: "Task Graph is missing the Task or Depends On column" }
    }

    const tasks = []
    for (let index = headerIndex + 2; index < lines.length; index += 1) {
        const line = lines[index].trim()
        if (!line.startsWith("|")) break
        const cells = line
            .split("|")
            .slice(1, -1)
            .map((cell) => cell.trim())
        const id = cells[taskColumn]
        if (!id) continue
        const dependsRaw = cells[dependsColumn] ?? ""
        const depends = dependsRaw
            .replace(/^\[|\]$/g, "")
            .split(",")
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0)
        tasks.push({
            id,
            dependsOn: depends,
            executionMode: modeColumn === -1 ? null : (cells[modeColumn] ?? null),
            line: index + 1,
        })
    }
    return { tasks, error: null }
}

function readOwns(goals) {
    return asArray(goals.owns)
        .map((entry) => {
            if (typeof entry === "string") return { path: entry, kind: "whole_file", selector: null }
            if (!entry || typeof entry !== "object") return null
            const boundary = entry.boundary ?? {}
            return {
                path: text(entry.path),
                kind: text(boundary.kind) || (boundary.selector ? "module" : "whole_file"),
                selector: text(boundary.selector) || null,
            }
        })
        .filter((entry) => entry && entry.path.length > 0)
}

function readReads(goals) {
    return asArray(goals.reads)
        .map((entry) => {
            if (typeof entry === "string") return { path: entry, kind: "module", selector: null }
            if (!entry || typeof entry !== "object") return null
            const boundary = entry.boundary ?? {}
            return {
                path: text(entry.path),
                kind: text(boundary.kind) || "module",
                selector: text(boundary.selector) || null,
            }
        })
        .filter((entry) => entry && entry.path.length > 0)
}

function readRequiredVerification(goals) {
    const required = goals.required_verification
    if (!required || typeof required !== "object" || Array.isArray(required)) return new Map()
    const map = new Map()
    for (const [id, entry] of Object.entries(required)) {
        map.set(id, {
            requiredResult: text(entry?.required_result) || "passed",
            claim: text(entry?.claim),
        })
    }
    return map
}

function readVerificationRecords(progress) {
    return asArray(progress.verification)
        .map((entry) => {
            if (!entry || typeof entry !== "object") return null
            return {
                check: text(entry.check),
                result: text(entry.result),
                conclusion: text(entry.conclusion),
            }
        })
        .filter(Boolean)
}

export function readTasks(workstreamDir) {
    const tasksDir = path.join(workstreamDir, "tasks")
    const problems = []
    if (!fs.existsSync(tasksDir)) return { tasks: new Map(), problems }
    const tasks = new Map()

    for (const entry of fs.readdirSync(tasksDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const dir = path.join(tasksDir, entry.name)
        const goalsPath = path.join(dir, "goals.yaml")
        const progressPath = path.join(dir, "progress.md")
        const planPath = path.join(dir, "plan.md")
        if (!fs.existsSync(goalsPath) && !fs.existsSync(progressPath)) continue

        const record = {
            directory: entry.name,
            dir: path.relative(process.cwd(), dir) || dir,
            goalsPath: fs.existsSync(goalsPath) ? path.relative(process.cwd(), goalsPath) : null,
            progressPath: fs.existsSync(progressPath) ? path.relative(process.cwd(), progressPath) : null,
            id: null,
            status: null,
            statusLine: null,
            owner: null,
            blockers: [],
            waitingFor: [],
            verification: [],
            requiredVerification: new Map(),
            owns: [],
            reads: [],
            acceptance: [],
            changedFiles: [],
            changedRegions: [],
            diagrams: [],
            architectureEvidence: null,
            evidenceProblems: [],
            nextAction: null,
        }

        if (record.goalsPath) {
            try {
                const goals = parseYamlLite(fs.readFileSync(goalsPath, "utf8"))
                if (!goals || typeof goals !== "object") {
                    problems.push({ file: record.goalsPath, message: "goals.yaml did not produce a mapping" })
                } else {
                    record.id = text(goals.id) || record.id
                    record.owns = readOwns(goals)
                    record.reads = readReads(goals)
                    record.acceptance = asArray(goals.acceptance).map(text).filter(Boolean)
                    record.requiredVerification = readRequiredVerification(goals)
                }
            } catch (error) {
                if (!(error instanceof YamlLiteError)) throw error
                problems.push({ file: record.goalsPath, message: `goals.yaml parse error: ${error.message}` })
            }
        }

        if (record.progressPath) {
            try {
                const { data, text: raw } = readFrontmatterFile(fs, progressPath)
                const statusIndex = raw.split(/\r?\n/).findIndex((line) => /^status\s*:/.test(line))
                record.status = text(data.status) || null
                // Frontmatter opens on line 1, so index 0 is reported as line 2.
                record.statusLine = statusIndex === -1 ? null : statusIndex + 2
                record.owner = text(data.owner) || null
                record.blockers = asArray(data.blockers).filter((item) => item !== null && item !== undefined)
                record.waitingFor = asArray(data.waiting_for).filter((item) => item !== null && item !== undefined)
                record.changedFiles = asArray(data.changed_files).map(text).filter(Boolean)
                record.changedRegions = asArray(data.changed_regions)
                record.nextAction = text(data.next_action) || null
                record.verification = readVerificationRecords(data)
                if (record.status === null) {
                    problems.push({ file: record.progressPath, message: "progress.md frontmatter has no status" })
                }
            } catch (error) {
                if (!(error instanceof YamlLiteError)) throw error
                problems.push({ file: record.progressPath, message: `progress.md frontmatter parse error: ${error.message}` })
            }
        }

        if (!record.id) record.id = entry.name.split("-").slice(0, 2).join("-").toUpperCase()

        if (fs.existsSync(planPath)) {
            const content = fs.readFileSync(planPath, "utf8")
            const relative = path.relative(process.cwd(), planPath)
            record.diagrams = extractMermaidBlocks(content, relative).map((block) =>
                parseFlowchart(block.lines, { file: block.file, firstLine: block.firstLine }),
            )
            const evidence = parseArchitectureEvidence(content, relative)
            record.architectureEvidence = evidence.evidence
            record.evidenceProblems = evidence.problems
            record.planPath = relative
        } else {
            record.planPath = null
        }

        tasks.set(record.id, record)
    }
    return { tasks, problems }
}

// Gate evaluation. Every decision here answers "may an AST check run for this task".
export function evaluateGates(task, planGraph) {
    const reasons = []
    const status = task.status

    if (!COMPLETED_STATUSES_FOR_AST.has(status ?? "")) {
        reasons.push(`task status is ${status ?? "unknown"}`)
    }
    if (task.waitingFor.length > 0) {
        reasons.push(`waiting_for is not empty (${task.waitingFor.length})`)
    }
    if (task.blockers.length > 0) {
        reasons.push(`blockers is not empty (${task.blockers.length})`)
    }

    for (const [id, required] of task.requiredVerification) {
        const matching = task.verification.filter((record) => record.check === id)
        if (matching.length === 0) {
            reasons.push(`required verification ${id} has no progress record`)
            continue
        }
        const satisfied = matching.some((record) => record.result === required.requiredResult)
        if (!satisfied) {
            reasons.push(
                `required verification ${id} is ${matching.map((record) => record.result).join("/")} not ${required.requiredResult}`,
            )
        }
    }

    const upstream = planGraph?.tasks.find((entry) => entry.id === task.id)
    return { astAllowed: reasons.length === 0, reasons, upstreamPending: upstream?.dependsOn ?? [] }
}

// Contradictions inside the records themselves, which are reported with [record] attribution.
export function findRecordContradictions(task) {
    const findings = []
    if (task.status !== COMPLETED) return findings

    for (const [id, required] of task.requiredVerification) {
        const matching = task.verification.filter((record) => record.check === id)
        const satisfied = matching.some((record) => record.result === required.requiredResult)
        if (!satisfied) {
            findings.push({
                rule: "completed_without_required_verification",
                message: `status is completed but ${id} is not ${required.requiredResult}`,
                file: task.progressPath,
            })
        }
    }
    if (task.waitingFor.length > 0) {
        findings.push({
            rule: "completed_with_waiting_for",
            message: "status is completed but waiting_for is not empty",
            file: task.progressPath,
        })
    }
    if (task.blockers.length > 0) {
        findings.push({
            rule: "completed_with_blockers",
            message: "status is completed but blockers is not empty",
            file: task.progressPath,
        })
    }
    for (const record of task.verification) {
        if (record.check && !task.requiredVerification.has(record.check)) {
            findings.push({
                rule: "unknown_verification_id",
                message: `progress verification "${record.check}" is not declared in goals.yaml required_verification`,
                file: task.progressPath,
            })
        }
    }
    return findings
}
