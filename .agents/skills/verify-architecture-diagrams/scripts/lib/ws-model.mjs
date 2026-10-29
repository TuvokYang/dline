// Workstream-side model: spec diagrams, the normative label sentence and the module table.

import fs from "node:fs"
import path from "node:path"

import { extractMermaidBlocks, parseFlowchart } from "./mermaid-parse.mjs"

const LABEL_SENTENCE = /Arrow labels are normative:\s*(.+)/i
const INLINE_LABEL = /`([^`]+)`/g
const ARCHITECTURE_MODE_PREFIX = "Architecture-Mode:"
const SUPPORTED_ARCHITECTURE_MODE = "diagram-driven-v1"

function linesOutsideFences(specText) {
    const lines = specText.replace(/^\uFEFF/, "").split(/\r?\n/)
    let fenced = false
    return lines.map((line, index) => {
        if (/^\s*```/.test(line)) {
            fenced = !fenced
            return null
        }
        return fenced ? null : { text: line, line: index + 1 }
    })
}

export function readArchitectureMode(specText) {
    const visible = linesOutsideFences(specText)
    const title = visible.find((entry) => entry && entry.text.trim().length > 0)
    if (!title || title.line !== 1 || !/^#\s+\S/.test(title.text)) {
        return { state: "tooling", reason: "spec.md must start with one Workstream H1 title", line: title?.line ?? 1 }
    }
    const firstBody = visible.find((entry) => entry && entry.line > title.line && entry.text.trim().length > 0)
    const candidates = visible.filter((entry) => entry && entry.text.trimStart().startsWith(ARCHITECTURE_MODE_PREFIX))
    if (candidates.length > 1) {
        return { state: "tooling", reason: "Architecture-Mode must be declared exactly once", line: candidates[1].line }
    }
    if (firstBody?.text === `${ARCHITECTURE_MODE_PREFIX} ${SUPPORTED_ARCHITECTURE_MODE}`) {
        return { state: "admitted", mode: SUPPORTED_ARCHITECTURE_MODE, line: firstBody.line }
    }
    if (candidates.length === 1) {
        const candidate = candidates[0]
        if (candidate !== firstBody) {
            return {
                state: "tooling",
                reason: "Architecture-Mode must be the first non-empty line after the title",
                line: candidate.line,
            }
        }
        if (candidate.text !== candidate.text.trim()) {
            return {
                state: "tooling",
                reason: "Architecture-Mode must not have leading or trailing whitespace",
                line: candidate.line,
            }
        }
        const mode = candidate.text.slice(ARCHITECTURE_MODE_PREFIX.length).trim()
        if (!mode) {
            return { state: "tooling", reason: "Architecture-Mode requires a non-empty value", line: candidate.line }
        }
        if (mode === SUPPORTED_ARCHITECTURE_MODE) {
            return {
                state: "tooling",
                reason: `Architecture-Mode must be exactly: ${ARCHITECTURE_MODE_PREFIX} ${SUPPORTED_ARCHITECTURE_MODE}`,
                line: candidate.line,
            }
        }
        return { state: "unsupported", mode, line: candidate.line }
    }
    return { state: "not-applicable" }
}

// The normative sentence lists meaningful solid-edge categories; dotted labels are not part of it.
export function readLabelVocabulary(specText) {
    const match = LABEL_SENTENCE.exec(specText)
    if (!match) return null
    const vocabulary = new Set()
    for (const inline of match[1].matchAll(INLINE_LABEL)) {
        vocabulary.add(inline[1].trim())
    }
    return vocabulary.size > 0 ? vocabulary : null
}

// Module responsibility table: | Module | Receives | Owns | Produces |
export function readModuleTable(specText) {
    const lines = specText.split(/\r?\n/)
    const start = lines.findIndex((line) => /^\|\s*Module\s*\|\s*Receives\s*\|/i.test(line.trim()))
    if (start === -1) return new Map()
    const modules = new Map()
    for (let index = start + 2; index < lines.length; index += 1) {
        const line = lines[index].trim()
        if (!line.startsWith("|")) break
        const cells = line
            .split("|")
            .slice(1, -1)
            .map((cell) => cell.trim())
        if (cells.length < 4) break
        modules.set(cells[0], { receives: cells[1], owns: cells[2], produces: cells[3], line: index + 1 })
    }
    return modules
}

export function readSpecModel(workstreamDir) {
    const specPath = path.join(workstreamDir, "spec.md")
    if (!fs.existsSync(specPath)) {
        return { error: { file: specPath, message: "spec.md not found" } }
    }
    const specText = fs.readFileSync(specPath, "utf8")
    const relativeSpec = path.relative(process.cwd(), specPath) || specPath
    const diagrams = extractMermaidBlocks(specText, relativeSpec).map((block) => {
        const parsed = parseFlowchart(block.lines, { file: block.file, firstLine: block.firstLine })
        return parsed
    })
    return {
        specPath: relativeSpec,
        specText,
        labelVocabulary: readLabelVocabulary(specText),
        moduleTable: readModuleTable(specText),
        diagrams,
    }
}

export function diagramHeading(specText, diagram) {
    const lines = specText.split(/\r?\n/)
    for (let index = Math.min(diagram.line - 2, lines.length - 1); index >= 0; index -= 1) {
        const heading = /^###\s+(.+)$/.exec(lines[index].trim())
        if (heading) return heading[1]
    }
    return null
}
