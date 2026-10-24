// Deterministic, language-neutral facts extracted from the Skill-local Tree-sitter runtime.
// Language queries decide what is captured; this module owns identity, locations,
// diagnostics, ordering and immutable snapshot shape.

import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import { QUERY_CATEGORIES } from "../../runtime/tree-sitter/queries/index.mjs"
import { disposeParsedSource, languageForPath, parseSource } from "./tree-sitter-runtime.mjs"

export const TREE_SITTER_FACT_SCHEMA_VERSION = 1
export const DEFAULT_TREE_SITTER_CATEGORIES = Object.freeze([...QUERY_CATEGORIES])

const MAX_CAPTURE_TEXT = 1024
const categorySet = new Set(QUERY_CATEGORIES)

function normalizedPath(filePath) {
    return filePath.replaceAll("\\", "/")
}

function isUnder(candidate, root) {
    const relative = path.relative(root, candidate)
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

export function canonicalSourcePath(repoRoot, filePath) {
    const absoluteRoot = path.resolve(repoRoot ?? process.cwd())
    const absolute = path.resolve(absoluteRoot, filePath)
    return isUnder(absolute, absoluteRoot) ? normalizedPath(path.relative(absoluteRoot, absolute)) : normalizedPath(absolute)
}

function stableHash(value) {
    return createHash("sha256").update(value).digest("hex")
}

function freezePoint(point, byte) {
    return Object.freeze({
        line: Number(point?.row ?? 0) + 1,
        column: Number(point?.column ?? 0) + 1,
        byte: Number(byte ?? 0),
    })
}

function captureText(node) {
    const full = String(node?.text ?? "")
    return Object.freeze({
        text: full.length <= MAX_CAPTURE_TEXT ? full : full.slice(0, MAX_CAPTURE_TEXT),
        textHash: stableHash(full),
        truncated: full.length > MAX_CAPTURE_TEXT,
    })
}

function factIdentity(fact) {
    return [fact.path, fact.category, fact.capture, fact.nodeType, fact.start.byte, fact.end.byte, fact.textHash].join("|")
}

function compareFacts(left, right) {
    return (
        left.path.localeCompare(right.path) ||
        left.start.byte - right.start.byte ||
        left.end.byte - right.end.byte ||
        left.category.localeCompare(right.category) ||
        left.capture.localeCompare(right.capture) ||
        left.nodeType.localeCompare(right.nodeType) ||
        left.textHash.localeCompare(right.textHash)
    )
}

function compareDiagnostics(left, right) {
    return (
        (left.path ?? "").localeCompare(right.path ?? "") ||
        (left.line ?? 0) - (right.line ?? 0) ||
        (left.column ?? 0) - (right.column ?? 0) ||
        left.rule.localeCompare(right.rule) ||
        left.message.localeCompare(right.message)
    )
}

function normalizeCategories(categories) {
    const normalized = [...new Set(categories ?? DEFAULT_TREE_SITTER_CATEGORIES)].sort()
    const unknown = normalized.filter((category) => !categorySet.has(category))
    if (unknown.length > 0) throw new Error(`unknown Tree-sitter query categories: ${unknown.join(", ")}`)
    return normalized
}

function nodeFlag(node, property) {
    const value = node?.[property]
    return typeof value === "function" ? Boolean(value.call(node)) : Boolean(value)
}

function childNodes(node) {
    if (Array.isArray(node?.children)) return node.children
    const result = []
    const count = Number(node?.childCount ?? 0)
    for (let index = 0; index < count; index += 1) {
        const child = node.child?.(index)
        if (child) result.push(child)
    }
    return result
}

function syntaxDiagnostics(rootNode, sourcePath, languageName) {
    if (!rootNode?.hasError) return []
    const diagnostics = []
    const visit = (node) => {
        const error = node?.type === "ERROR" || nodeFlag(node, "isError")
        const missing = nodeFlag(node, "isMissing")
        if (error || missing) {
            diagnostics.push(
                Object.freeze({
                    provider: "tree-sitter",
                    rule: missing ? "missing-syntax" : "syntax-error",
                    path: sourcePath,
                    language: languageName,
                    line: Number(node.startPosition?.row ?? 0) + 1,
                    column: Number(node.startPosition?.column ?? 0) + 1,
                    message: `${languageName} parser reported ${missing ? "missing syntax" : "an error node"} at ${sourcePath}`,
                }),
            )
            return
        }
        for (const child of childNodes(node)) visit(child)
    }
    visit(rootNode)
    if (diagnostics.length > 0) return diagnostics.sort(compareDiagnostics)
    return [
        Object.freeze({
            provider: "tree-sitter",
            rule: "syntax-error",
            path: sourcePath,
            language: languageName,
            line: 1,
            column: 1,
            message: `${languageName} parser reported syntax errors in ${sourcePath}`,
        }),
    ]
}

function captureFacts(parsed, sourcePath, categories) {
    const facts = []
    const diagnostics = []
    for (const category of categories) {
        const query = parsed.queries?.[category]
        if (!query) {
            diagnostics.push(
                Object.freeze({
                    provider: "tree-sitter",
                    rule: "query-category-unavailable",
                    path: sourcePath,
                    language: parsed.languageName,
                    line: 1,
                    column: 1,
                    message: `${parsed.languageName} has no ${category} query`,
                }),
            )
            continue
        }
        for (const capture of query.captures(parsed.tree.rootNode)) {
            const text = captureText(capture.node)
            const fact = {
                schemaVersion: TREE_SITTER_FACT_SCHEMA_VERSION,
                category,
                capture: capture.name,
                path: sourcePath,
                language: parsed.languageName,
                nodeType: capture.node.type,
                start: freezePoint(capture.node.startPosition, capture.node.startIndex),
                end: freezePoint(capture.node.endPosition, capture.node.endIndex),
                ...text,
            }
            fact.id = stableHash(factIdentity(fact))
            facts.push(Object.freeze(fact))
        }
    }
    const seen = new Set()
    return {
        facts: facts.sort(compareFacts).filter((fact) => {
            const key = factIdentity(fact)
            if (seen.has(key)) return false
            seen.add(key)
            return true
        }),
        diagnostics: diagnostics.sort(compareDiagnostics),
    }
}

export async function scanTreeSitterSource({
    repoRoot = process.cwd(),
    filePath,
    source,
    categories = DEFAULT_TREE_SITTER_CATEGORIES,
}) {
    const sourcePath = canonicalSourcePath(repoRoot, filePath)
    const languageName = languageForPath(filePath)
    if (!languageName) {
        return Object.freeze({
            file: Object.freeze({ path: sourcePath, language: null, state: "unsupported", factCount: 0 }),
            facts: Object.freeze([]),
            diagnostics: Object.freeze([
                Object.freeze({
                    provider: "tree-sitter",
                    rule: "unsupported-language",
                    path: sourcePath,
                    language: null,
                    line: 1,
                    column: 1,
                    message: `unsupported Tree-sitter language for ${sourcePath}`,
                }),
            ]),
        })
    }
    const selectedCategories = normalizeCategories(categories)
    const parsed = await parseSource(filePath, source, { categories: selectedCategories })
    try {
        const captured = captureFacts(parsed, sourcePath, selectedCategories)
        const diagnostics = [...syntaxDiagnostics(parsed.tree.rootNode, sourcePath, languageName), ...captured.diagnostics].sort(
            compareDiagnostics,
        )
        return Object.freeze({
            file: Object.freeze({
                path: sourcePath,
                language: languageName,
                state: diagnostics.some((entry) => entry.rule === "syntax-error" || entry.rule === "missing-syntax")
                    ? "syntax_error"
                    : "parsed",
                factCount: captured.facts.length,
            }),
            facts: Object.freeze(captured.facts),
            diagnostics: Object.freeze(diagnostics),
        })
    } finally {
        disposeParsedSource(parsed)
    }
}

export async function scanTreeSitterFiles({
    repoRoot = process.cwd(),
    files,
    categories = DEFAULT_TREE_SITTER_CATEGORIES,
    readFile = (filePath) => fs.readFileSync(filePath, "utf8"),
}) {
    const absoluteRoot = path.resolve(repoRoot)
    const selectedCategories = normalizeCategories(categories)
    const uniqueFiles = [...new Set((files ?? []).map((filePath) => path.resolve(absoluteRoot, filePath)))].sort((left, right) =>
        canonicalSourcePath(absoluteRoot, left).localeCompare(canonicalSourcePath(absoluteRoot, right)),
    )
    const fileFacts = []
    const facts = []
    const diagnostics = []
    for (const absolute of uniqueFiles) {
        let source
        try {
            source = readFile(absolute)
        } catch (error) {
            const sourcePath = canonicalSourcePath(absoluteRoot, absolute)
            diagnostics.push(
                Object.freeze({
                    provider: "tree-sitter",
                    rule: "source-read-failed",
                    path: sourcePath,
                    language: languageForPath(absolute),
                    line: 1,
                    column: 1,
                    message: `cannot read ${sourcePath}: ${error?.message ?? String(error)}`,
                }),
            )
            continue
        }
        const result = await scanTreeSitterSource({
            repoRoot: absoluteRoot,
            filePath: absolute,
            source,
            categories: selectedCategories,
        })
        fileFacts.push(result.file)
        facts.push(...result.facts)
        diagnostics.push(...result.diagnostics)
    }
    return Object.freeze({
        schemaVersion: TREE_SITTER_FACT_SCHEMA_VERSION,
        categories: Object.freeze(selectedCategories),
        files: Object.freeze(fileFacts.sort((left, right) => left.path.localeCompare(right.path))),
        facts: Object.freeze(facts.sort(compareFacts)),
        diagnostics: Object.freeze(diagnostics.sort(compareDiagnostics)),
    })
}
