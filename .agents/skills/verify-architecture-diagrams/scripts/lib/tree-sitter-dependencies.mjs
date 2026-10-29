// Bounded dependency closure and runtime coupling analysis over Tree-sitter facts.

import fs from "node:fs"
import path from "node:path"
import { canonicalSourcePath, scanTreeSitterSource } from "./tree-sitter-facts.mjs"
import { languageForPath, supportedExtensions } from "./tree-sitter-runtime.mjs"

const EXTENSIONS = supportedExtensions()

function isUnder(candidate, root) {
    const relative = path.relative(root, candidate)
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function importFacts(facts) {
    return facts.filter((fact) => fact.category === "imports" && ["import.declaration", "import.require"].includes(fact.capture))
}

function quoted(text) {
    return [...text.matchAll(/["']([^"']+)["']/g)].map((match) => match[1])
}

function specifiers(language, text) {
    if (["javascript", "typescript", "tsx"].includes(language)) return quoted(text).slice(-1)
    if (language === "python") {
        const from = /^\s*from\s+([.\w]+)\s+import\b/.exec(text)
        if (from) return [from[1]]
        const imported = /^\s*import\s+(.+)$/.exec(text)
        return imported ? imported[1].split(",").map((entry) => entry.trim().split(/\s+as\s+/)[0]) : []
    }
    if (["c", "cpp"].includes(language))
        return quoted(text).length > 0 ? quoted(text) : [...text.matchAll(/<([^>]+)>/g)].map((match) => match[1])
    if (language === "rust")
        return [
            text
                .replace(/^\s*use\s+/, "")
                .replace(/;\s*$/, "")
                .trim(),
        ]
    if (["go", "ruby"].includes(language)) return quoted(text)
    if (["java", "kotlin"].includes(language)) {
        const match = /\bimport\s+([\w.*]+)/.exec(text)
        return match ? [match[1]] : []
    }
    if (language === "c_sharp") {
        const match = /\busing\s+([\w.]+)/.exec(text)
        return match ? [match[1]] : []
    }
    if (language === "php") {
        const match = /\buse\s+([^;]+)/.exec(text)
        return match ? [match[1].trim()] : []
    }
    return []
}

function classify(language, text) {
    if (["typescript", "tsx"].includes(language)) {
        if (/\b(?:import|export)\s+type\b/.test(text)) return "type"
        const typeBindings = (text.match(/\btype\s+[A-Za-z_$]/g) ?? []).length
        if (typeBindings > 0) {
            const body = /\{([^}]+)\}/.exec(text)?.[1] ?? ""
            const entries = body
                .split(",")
                .map((entry) => entry.trim())
                .filter(Boolean)
            return entries.length > 0 && entries.every((entry) => /^type\b/.test(entry)) ? "type" : "mixed"
        }
        return "runtime"
    }
    if (["javascript", "python", "ruby", "go"].includes(language)) return "runtime"
    if (["java", "kotlin", "c_sharp"].includes(language)) return "type"
    if (["c", "cpp", "rust", "php"].includes(language)) return "unknown"
    return "unknown"
}

// Copy JSONC text outside-string characters through `onCode`, string literals verbatim. tsconfig
// path patterns such as "@/*" and targets such as "./a,}" must never be read as syntax.
function scanJsonc(text, onCode) {
    let output = ""
    for (let index = 0; index < text.length; index++) {
        const char = text[index]
        if (char !== '"') {
            const consumed = onCode(text, index)
            output += consumed.emit
            index = consumed.next
            continue
        }
        let end = index + 1
        while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1
        output += text.slice(index, end + 1)
        index = end
    }
    return output
}

function stripComment(text, index) {
    if (text[index] === "/" && text[index + 1] === "/") {
        const end = text.indexOf("\n", index)
        return end < 0 ? { emit: "", next: text.length } : { emit: "\n", next: end }
    }
    if (text[index] === "/" && text[index + 1] === "*") {
        const end = text.indexOf("*/", index + 2)
        return { emit: "", next: end < 0 ? text.length : end + 1 }
    }
    return { emit: text[index], next: index }
}

// Runs after comments are gone, so only whitespace can separate a trailing comma from its closer.
function stripTrailingComma(text, index) {
    if (text[index] !== ",") return { emit: text[index], next: index }
    let ahead = index + 1
    while (ahead < text.length && /\s/.test(text[ahead])) ahead++
    return { emit: text[ahead] === "}" || text[ahead] === "]" ? "" : ",", next: index }
}

function parseJsonc(text) {
    return JSON.parse(scanJsonc(scanJsonc(text, stripComment), stripTrailingComma))
}

function tsconfigPathEntries(dir) {
    let names
    try {
        names = fs.readdirSync(dir).filter((name) => /^tsconfig(?:\..+)?\.json$/.test(name))
    } catch {
        return null
    }
    // tsconfig.json first, then siblings by name, so resolution order is stable.
    names.sort((left, right) => (left === "tsconfig.json" ? -1 : right === "tsconfig.json" ? 1 : left.localeCompare(right)))
    let entries = null
    for (const name of names) {
        let options
        try {
            options = parseJsonc(fs.readFileSync(path.join(dir, name), "utf8"))?.compilerOptions
        } catch {
            continue
        }
        if (!options?.paths || typeof options.paths !== "object") continue
        const baseDir = path.resolve(dir, typeof options.baseUrl === "string" ? options.baseUrl : ".")
        for (const [pattern, targets] of Object.entries(options.paths)) {
            if (!Array.isArray(targets)) continue
            entries ??= []
            entries.push({
                pattern,
                targets: targets.filter((target) => typeof target === "string").map((target) => path.resolve(baseDir, target)),
            })
        }
    }
    return entries
}

// TypeScript `compilerOptions.paths` aliases come from the importer's nearest ancestor directory
// that declares any. Every tsconfig*.json in that directory contributes, because solution-style
// roots keep the real mapping in a sibling such as tsconfig.app.json. `extends` is not followed.
function createAliasResolver(repoRoot) {
    const byDirectory = new Map()
    const entriesFor = (importer) => {
        for (let dir = path.dirname(importer); isUnder(dir, repoRoot); ) {
            if (!byDirectory.has(dir)) byDirectory.set(dir, tsconfigPathEntries(dir))
            const entries = byDirectory.get(dir)
            if (entries) return entries
            const parent = path.dirname(dir)
            if (parent === dir) break
            dir = parent
        }
        return []
    }
    // Like TypeScript, one pattern wins (an exact pattern first, otherwise the wildcard with the
    // longest prefix) and only that pattern's targets are tried, in order. A less specific pattern
    // is never a fallback, so a winning alias whose targets are missing stays unresolved.
    return (importer, specifier) => {
        let winner = null
        for (const { pattern, targets } of entriesFor(importer)) {
            const star = pattern.indexOf("*")
            if (star < 0) {
                if (specifier === pattern) return targets
                continue
            }
            const prefix = pattern.slice(0, star)
            const suffix = pattern.slice(star + 1)
            if (specifier.length < prefix.length + suffix.length) continue
            if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue
            if (winner && winner.prefix.length >= prefix.length) continue
            winner = { prefix, targets, captured: specifier.slice(prefix.length, specifier.length - suffix.length) }
        }
        return winner ? winner.targets.map((target) => path.resolve(target.replace("*", winner.captured))) : []
    }
}

const NO_ALIASES = () => []

function candidateBases(repoRoot, importer, language, specifier, aliasBases = NO_ALIASES) {
    const importerDir = path.dirname(importer)
    if (specifier.startsWith(".")) return [path.resolve(importerDir, specifier)]
    if (path.isAbsolute(specifier)) return [path.resolve(specifier)]
    if (["typescript", "tsx", "javascript"].includes(language)) return aliasBases(importer, specifier)
    if (["c", "cpp", "ruby"].includes(language) && !specifier.includes(":")) {
        return [path.resolve(importerDir, specifier), path.resolve(repoRoot, specifier)]
    }
    if (language === "python") {
        const relativeDots = /^\.+/.exec(specifier)?.[0].length ?? 0
        const body = specifier.slice(relativeDots).replaceAll(".", "/")
        const base = relativeDots > 0 ? path.resolve(importerDir, ...Array(Math.max(0, relativeDots - 1)).fill("..")) : repoRoot
        return [path.resolve(base, body)]
    }
    if (["java", "kotlin", "c_sharp"].includes(language))
        return [path.resolve(repoRoot, specifier.replaceAll(".", "/").replace(/\.\*$/, ""))]
    if (language === "rust" && specifier.startsWith("crate::"))
        return [path.resolve(repoRoot, "src", specifier.slice(7).replaceAll("::", "/"))]
    if (language === "php") return [path.resolve(repoRoot, specifier.replaceAll("\\", "/"))]
    return []
}

function suffixes(language) {
    if (["typescript", "tsx"].includes(language)) return [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]
    if (language === "javascript") return [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"]
    if (language === "python") return [".py"]
    if (language === "ruby") return [".rb"]
    if (language === "rust") return [".rs"]
    if (language === "go") return [".go"]
    if (language === "java") return [".java"]
    if (language === "kotlin") return [".kt"]
    if (language === "c_sharp") return [".cs"]
    if (language === "php") return [".php"]
    if (language === "c") return [".c", ".h"]
    if (language === "cpp") return [".cpp", ".cc", ".hpp", ".h"]
    return EXTENSIONS
}

function resolveWorkspace(repoRoot, importer, language, specifier, aliasBases = NO_ALIASES) {
    for (const base of candidateBases(repoRoot, importer, language, specifier, aliasBases)) {
        const candidates = [
            base,
            ...suffixes(language).map((suffix) => `${base}${suffix}`),
            ...suffixes(language).map((suffix) => path.join(base, `index${suffix}`)),
        ]
        for (const candidate of candidates) {
            if (!isUnder(candidate, repoRoot) || !fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) continue
            if (!languageForPath(candidate)) continue
            return path.resolve(candidate)
        }
    }
    return null
}

function components(nodes, edges) {
    const outgoing = new Map([...nodes].map((node) => [node, []]))
    for (const edge of edges) outgoing.get(edge.importer)?.push(edge.target.path)
    let index = 0
    const indices = new Map()
    const low = new Map()
    const stack = []
    const onStack = new Set()
    const result = []
    const visit = (node) => {
        indices.set(node, index)
        low.set(node, index++)
        stack.push(node)
        onStack.add(node)
        for (const next of outgoing.get(node) ?? []) {
            if (!indices.has(next)) {
                visit(next)
                low.set(node, Math.min(low.get(node), low.get(next)))
            } else if (onStack.has(next)) low.set(node, Math.min(low.get(node), indices.get(next)))
        }
        if (low.get(node) !== indices.get(node)) return
        const component = []
        for (;;) {
            const member = stack.pop()
            onStack.delete(member)
            component.push(member)
            if (member === node) break
        }
        const selfLoop = component.length === 1 && (outgoing.get(component[0]) ?? []).includes(component[0])
        if (component.length > 1 || selfLoop) result.push(Object.freeze(component.sort()))
    }
    for (const node of [...nodes].sort()) if (!indices.has(node)) visit(node)
    return result.sort((left, right) => left.join("|").localeCompare(right.join("|")))
}

export async function buildDependencyClosure({ repoRoot = process.cwd(), seeds, maxFiles = 256, maxDepth = 32 } = {}) {
    const absoluteRoot = path.resolve(repoRoot)
    const queue = [...new Set((seeds ?? []).map((seed) => path.resolve(absoluteRoot, seed)))]
        .sort()
        .map((file) => ({ file, depth: 0 }))
    const visited = new Set()
    const facts = []
    const imports = []
    const diagnostics = []
    const aliasBases = createAliasResolver(absoluteRoot)
    while (queue.length > 0) {
        const current = queue.shift()
        if (visited.has(current.file)) continue
        if (visited.size >= maxFiles) {
            diagnostics.push({ rule: "closure-file-limit", message: `dependency closure reached maxFiles=${maxFiles}` })
            break
        }
        if (current.depth > maxDepth) {
            diagnostics.push({
                rule: "closure-depth-limit",
                file: canonicalSourcePath(absoluteRoot, current.file),
                message: `dependency closure exceeded maxDepth=${maxDepth}`,
            })
            continue
        }
        if (!isUnder(current.file, absoluteRoot) || !fs.existsSync(current.file) || !fs.statSync(current.file).isFile()) {
            diagnostics.push({
                rule: "closure-seed-missing",
                file: canonicalSourcePath(absoluteRoot, current.file),
                message: "bounded dependency input is missing or outside repoRoot",
            })
            continue
        }
        visited.add(current.file)
        const source = fs.readFileSync(current.file, "utf8")
        const scan = await scanTreeSitterSource({ repoRoot: absoluteRoot, filePath: current.file, source })
        facts.push(...scan.facts)
        diagnostics.push(...scan.diagnostics)
        for (const fact of importFacts(scan.facts)) {
            for (const specifier of specifiers(scan.file.language, fact.text)) {
                const classification = classify(scan.file.language, fact.text)
                const resolved = resolveWorkspace(absoluteRoot, current.file, scan.file.language, specifier, aliasBases)
                const edge = Object.freeze({
                    importer: scan.file.path,
                    line: fact.start.line,
                    language: scan.file.language,
                    specifier,
                    classification,
                    target: resolved
                        ? Object.freeze({ kind: "workspace", path: canonicalSourcePath(absoluteRoot, resolved) })
                        : Object.freeze({
                              kind:
                                  candidateBases(absoluteRoot, current.file, scan.file.language, specifier, aliasBases).length > 0
                                      ? "unresolved"
                                      : "external",
                              specifier,
                          }),
                })
                imports.push(edge)
                if (resolved && !visited.has(resolved)) queue.push({ file: resolved, depth: current.depth + 1 })
            }
        }
        // Breadth-first by depth, then path: an alphabetical-only order lets the dependencies of an early
        // seed exhaust maxFiles before a later seed is ever scanned, which turns a truncated closure into
        // missing facts for explicitly bound artifacts.
        queue.sort(
            (left, right) =>
                left.depth - right.depth ||
                canonicalSourcePath(absoluteRoot, left.file).localeCompare(canonicalSourcePath(absoluteRoot, right.file)),
        )
    }
    imports.sort(
        (left, right) =>
            left.importer.localeCompare(right.importer) ||
            left.line - right.line ||
            left.specifier.localeCompare(right.specifier),
    )
    const runtimeEdges = imports.filter(
        (edge) => edge.target.kind === "workspace" && ["runtime", "mixed"].includes(edge.classification),
    )
    const files = [...visited].map((file) => canonicalSourcePath(absoluteRoot, file)).sort()
    return Object.freeze({
        files: Object.freeze(files),
        facts: Object.freeze(facts),
        imports: Object.freeze(imports),
        runtimeSccs: Object.freeze(components(new Set(files), runtimeEdges)),
        diagnostics: Object.freeze(diagnostics),
    })
}
