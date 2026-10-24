// Self-contained Tree-sitter WASM runtime owned by this Skill.

import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { querySourcesForLanguage } from "../../runtime/tree-sitter/queries/index.mjs"

const require = createRequire(import.meta.url)
const Parser = require("../../runtime/tree-sitter/tree-sitter.js")
const runtimeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../runtime/tree-sitter")
const runtimeWasm = path.join(runtimeRoot, "tree-sitter.wasm")
const grammarRoot = path.join(runtimeRoot, "grammars")

const extensionLanguages = Object.freeze({
    ".c": "c",
    ".cc": "cpp",
    ".cjs": "javascript",
    ".cpp": "cpp",
    ".cs": "c_sharp",
    ".cts": "typescript",
    ".go": "go",
    ".h": "c",
    ".hpp": "cpp",
    ".java": "java",
    ".js": "javascript",
    ".jsx": "javascript",
    ".kt": "kotlin",
    ".mjs": "javascript",
    ".mts": "typescript",
    ".php": "php",
    ".py": "python",
    ".rb": "ruby",
    ".rs": "rust",
    ".ts": "typescript",
    ".tsx": "tsx",
})

let initialization
const languageLoads = new Map()

async function initializeRuntime() {
    initialization ??= Parser.init({
        locateFile(fileName) {
            return fileName.endsWith(".wasm") ? runtimeWasm : path.join(runtimeRoot, fileName)
        },
    }).catch((error) => {
        initialization = undefined
        throw error
    })
    await initialization
}

async function loadLanguage(languageName) {
    const cached = languageLoads.get(languageName)
    if (cached) return cached
    const promise = Parser.Language.load(path.join(grammarRoot, `tree-sitter-${languageName}.wasm`)).catch((error) => {
        languageLoads.delete(languageName)
        throw error
    })
    languageLoads.set(languageName, promise)
    return promise
}

export function supportedExtensions() {
    return Object.keys(extensionLanguages).sort()
}

export function languageForPath(filePath) {
    return extensionLanguages[path.extname(filePath).toLowerCase()] ?? null
}

export async function createLanguageParser(filePath, { categories = null } = {}) {
    const languageName = languageForPath(filePath)
    if (!languageName) throw new Error(`unsupported Tree-sitter language for ${filePath}`)
    await initializeRuntime()
    const language = await loadLanguage(languageName)
    const parser = new Parser()
    parser.setLanguage(language)
    const querySources = querySourcesForLanguage(languageName) ?? {}
    const selected = categories === null ? null : new Set(categories)
    const queries = Object.freeze(
        Object.fromEntries(
            Object.entries(querySources)
                .filter(
                    ([category, source]) =>
                        (selected === null || selected.has(category)) && typeof source === "string" && source.trim().length > 0,
                )
                .map(([category, source]) => [category, language.query(source)]),
        ),
    )
    return Object.freeze({ languageName, parser, queries, definitionQuery: queries.declarations ?? null })
}

export async function parseSource(filePath, source, options = {}) {
    const runtime = await createLanguageParser(filePath, options)
    const tree = runtime.parser.parse(source)
    if (!tree?.rootNode) {
        runtime.parser.delete?.()
        throw new Error(`Tree-sitter produced no root node for ${filePath}`)
    }
    return Object.freeze({ ...runtime, tree })
}

export function disposeParsedSource(parsed) {
    for (const query of new Set(Object.values(parsed.queries ?? {}))) query?.delete?.()
    if (!parsed.queries) parsed.definitionQuery?.delete?.()
    parsed.tree?.delete?.()
    parsed.parser?.delete?.()
}
