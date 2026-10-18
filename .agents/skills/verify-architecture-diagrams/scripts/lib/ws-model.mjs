// Workstream-side model: spec diagrams, the normative label sentence and the module table.

import fs from "node:fs"
import path from "node:path"

import { extractMermaidBlocks, parseFlowchart } from "./mermaid-parse.mjs"

const LABEL_SENTENCE = /Arrow labels are normative:\s*(.+)/i
const INLINE_LABEL = /`([^`]+)`/g

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
