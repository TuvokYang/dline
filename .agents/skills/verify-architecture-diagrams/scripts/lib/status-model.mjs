// Workstream status projection. The projection is never authoritative: when it
// disagrees with a task's progress.md, the verifier follows progress.md and only
// records the stale projection as "not checked".

import fs from "node:fs"
import path from "node:path"

import { parseYamlLite, readFrontmatterFile, YamlLiteError } from "./yaml-lite.mjs"

function text(value) {
    return typeof value === "string" ? value.trim() : ""
}

export function readWorkstreamStatus(workstreamDir) {
    const statusPath = path.join(workstreamDir, "status.yml")
    const result = { statuses: new Map(), file: null, problem: null }
    if (!fs.existsSync(statusPath)) return result
    result.file = path.relative(process.cwd(), statusPath) || statusPath
    try {
        const data = parseYamlLite(fs.readFileSync(statusPath, "utf8"))
        const workstreams = data?.workstreams
        if (!workstreams || typeof workstreams !== "object") return result
        for (const entry of Object.values(workstreams)) {
            const tasks = entry?.tasks
            if (!tasks || typeof tasks !== "object") continue
            for (const [taskId, status] of Object.entries(tasks)) {
                result.statuses.set(taskId, text(status))
            }
        }
    } catch (error) {
        if (!(error instanceof YamlLiteError)) throw error
        result.problem = `${result.file}: ${error.message}`
    }
    return result
}

export function findStaleProjections(tasks, ...projections) {
    const stale = []
    for (const projection of projections) {
        if (!projection || projection.statuses.size === 0) continue
        for (const [taskId, projected] of projection.statuses) {
            const task = tasks.get(taskId)
            if (!task) continue
            if (task.status && projected && task.status !== projected) {
                stale.push({
                    task: taskId,
                    projection: projection.file,
                    projected,
                    authoritative: task.status,
                    authoritativeFile: task.progressPath,
                })
            }
        }
    }
    return stale
}

export function readWorkstreamProgress(workstreamDir) {
    const progressPath = path.join(workstreamDir, "progress.md")
    if (!fs.existsSync(progressPath)) return null
    try {
        const { data } = readFrontmatterFile(fs, progressPath)
        return { path: path.relative(process.cwd(), progressPath), data }
    } catch (error) {
        if (!(error instanceof YamlLiteError)) throw error
        return { path: path.relative(process.cwd(), progressPath), data: null, problem: error.message }
    }
}
