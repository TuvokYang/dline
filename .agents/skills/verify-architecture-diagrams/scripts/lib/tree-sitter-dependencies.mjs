// Bounded dependency closure and runtime coupling analysis over Tree-sitter facts.

import fs from "node:fs"
import path from "node:path"
import { canonicalSourcePath, scanTreeSitterSource } from "./tree-sitter-facts.mjs"
import { languageForPath, supportedExtensions } from "./tree-sitter-runtime.mjs"

const EXTENSIONS = supportedExtensions()

function normalized(value) {
    return value.replaceAll("\\", "/")
}

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

function candidateBases(repoRoot, importer, language, specifier) {
    const importerDir = path.dirname(importer)
    if (specifier.startsWith(".")) return [path.resolve(importerDir, specifier)]
    if (path.isAbsolute(specifier)) return [path.resolve(specifier)]
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

function resolveWorkspace(repoRoot, importer, language, specifier) {
    for (const base of candidateBases(repoRoot, importer, language, specifier)) {
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
                const resolved = resolveWorkspace(absoluteRoot, current.file, scan.file.language, specifier)
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
                                  candidateBases(absoluteRoot, current.file, scan.file.language, specifier).length > 0
                                      ? "unresolved"
                                      : "external",
                              specifier,
                          }),
                })
                imports.push(edge)
                if (resolved && !visited.has(resolved)) queue.push({ file: resolved, depth: current.depth + 1 })
            }
        }
        queue.sort((left, right) =>
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
