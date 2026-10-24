// Stage 6: does the code behind a gated task diagram exist?
// This module uses only the Skill-local Tree-sitter runtime. It never loads a
// target package, compiler configuration or product source module.

import fs from "node:fs"
import path from "node:path"

import { buildDependencyClosure } from "./tree-sitter-dependencies.mjs"
import { canonicalSourcePath, scanTreeSitterSource } from "./tree-sitter-facts.mjs"
import { languageForPath, supportedExtensions } from "./tree-sitter-runtime.mjs"

const SOURCE_SUFFIXES = supportedExtensions()

function finding(severity, attribution, subject, rule, message, task) {
    return {
        severity,
        attribution,
        stage: "6",
        file: subject?.file ?? null,
        line: subject?.line ?? null,
        diagram: task ?? null,
        rule,
        message,
        task: task ?? null,
    }
}

function resolveDeclaredPath(repoRoot, declaredPath) {
    const target = path.resolve(repoRoot, declaredPath)
    if (fs.existsSync(target)) return target
    for (const suffix of SOURCE_SUFFIXES) {
        const file = `${target}${suffix}`
        if (fs.existsSync(file) && fs.statSync(file).isFile()) return file
        const index = path.join(target, `index${suffix}`)
        if (fs.existsSync(index) && fs.statSync(index).isFile()) return index
    }
    return null
}

function declarationNames(facts, sourcePath) {
    return new Set(
        facts
            .filter(
                (fact) =>
                    fact.path === sourcePath &&
                    fact.category === "declarations" &&
                    (fact.capture === "name" || fact.capture.startsWith("name.")),
            )
            .map((fact) => fact.text),
    )
}

function syntaxFailed(diagnostics) {
    return diagnostics.some((entry) => entry.rule === "syntax-error" || entry.rule === "missing-syntax")
}

function targetMatches(repoRoot, targetAbsolute, targetPath) {
    const wanted = canonicalSourcePath(repoRoot, targetAbsolute)
    if (fs.statSync(targetAbsolute).isFile()) return targetPath === wanted
    const relative = path.posix.relative(wanted, targetPath)
    return relative.length > 0 && !relative.startsWith("../") && relative !== ".."
}

export async function checkAstForTask({ task, wsModules, repoRoot }) {
    void wsModules
    const findings = []
    const moduleNodes = []
    for (const diagram of task.diagrams) {
        for (const [nodeId, modulePath] of diagram.modules) moduleNodes.push({ nodeId, modulePath, diagram })
    }

    for (const boundary of task.owns) {
        const resolved = resolveDeclaredPath(repoRoot, boundary.path)
        if (!resolved) {
            findings.push(
                finding(
                    "unverifiable",
                    "diagram",
                    { file: boundary.path },
                    "owned-module-missing",
                    `${task.id} owns ${boundary.path} (${boundary.kind}) but no file or directory exists at that path`,
                    task.id,
                ),
            )
            continue
        }
        if (boundary.kind !== "symbol") continue
        if (!fs.statSync(resolved).isFile() || !languageForPath(resolved)) {
            findings.push(
                finding(
                    "unverifiable",
                    "diagram",
                    { file: boundary.path },
                    "owned-symbol-unverifiable",
                    `${task.id} owns symbol "${boundary.selector}" in ${boundary.path}, but the boundary is not one supported source file`,
                    task.id,
                ),
            )
            continue
        }
        const scan = await scanTreeSitterSource({
            repoRoot,
            filePath: resolved,
            source: fs.readFileSync(resolved, "utf8"),
            categories: ["declarations"],
        })
        if (syntaxFailed(scan.diagnostics)) {
            findings.push(
                finding(
                    "unverifiable",
                    "diagram",
                    { file: boundary.path },
                    "owned-symbol-unverifiable",
                    `${task.id} owns symbol "${boundary.selector}" in ${boundary.path}, but syntax errors prevent declaration proof`,
                    task.id,
                ),
            )
            continue
        }
        const expected = String(boundary.selector ?? "")
            .split(/[,;]/)
            .map((entry) => entry.trim())
            .filter(Boolean)
        const names = declarationNames(scan.facts, scan.file.path)
        if (expected.length > 0 && !expected.some((symbol) => names.has(symbol) || names.has(symbol.split(".")[0]))) {
            findings.push(
                finding(
                    "unverifiable",
                    "diagram",
                    { file: boundary.path },
                    "owned-symbol-unverifiable",
                    `${task.id} owns symbol "${boundary.selector}" in ${boundary.path}, but available declaration facts do not capture it; absence is not inferred`,
                    task.id,
                ),
            )
        }
    }

    for (const entry of moduleNodes) {
        if (resolveDeclaredPath(repoRoot, entry.modulePath)) continue
        findings.push(
            finding(
                "unverifiable",
                "diagram",
                { file: entry.diagram.file, line: entry.diagram.line },
                "diagram-module-missing",
                `${task.id} binds node ${entry.nodeId} to ${entry.modulePath}, which does not exist`,
                task.id,
            ),
        )
    }

    const edges = task.diagrams.flatMap((diagram) =>
        diagram.edges.filter((edge) => edge.style === "solid").map((edge) => ({ edge, diagram })),
    )
    for (const { edge, diagram } of edges) {
        const fromPath = diagram.modules.get(edge.from)
        const toPath = diagram.modules.get(edge.to)
        if (!fromPath || !toPath) continue
        const fromResolved = resolveDeclaredPath(repoRoot, fromPath)
        const toResolved = resolveDeclaredPath(repoRoot, toPath)
        if (!fromResolved || !toResolved) continue
        if (!fs.statSync(fromResolved).isFile() || !languageForPath(fromResolved)) {
            findings.push(
                finding(
                    "unverifiable",
                    "diagram",
                    { file: diagram.file, line: edge.line },
                    "implemented-edge-unverifiable",
                    `${task.id} draws ${edge.from} --> ${edge.to}, but ${fromPath} is not one supported source file`,
                    task.id,
                ),
            )
            continue
        }
        const closure = await buildDependencyClosure({ repoRoot, seeds: [fromResolved], maxFiles: 128, maxDepth: 16 })
        if (syntaxFailed(closure.diagnostics)) {
            findings.push(
                finding(
                    "unverifiable",
                    "diagram",
                    { file: diagram.file, line: edge.line },
                    "implemented-edge-unverifiable",
                    `${task.id} cannot prove ${edge.from} --> ${edge.to} because the source closure has syntax errors`,
                    task.id,
                ),
            )
            continue
        }
        const fromCanonical = canonicalSourcePath(repoRoot, fromResolved)
        const importsTarget = closure.imports.some(
            (dependency) =>
                dependency.importer === fromCanonical &&
                dependency.target.kind === "workspace" &&
                ["runtime", "mixed"].includes(dependency.classification) &&
                targetMatches(repoRoot, toResolved, dependency.target.path),
        )
        if (!importsTarget) {
            findings.push(
                finding(
                    "not-checked",
                    "diagram",
                    { file: diagram.file, line: edge.line },
                    "implemented-edge-without-direct-import",
                    `${task.id} draws ${edge.from} --> ${edge.to} between ${fromPath} and ${toPath}, but no direct runtime import proves it; use Architecture Evidence for injected, callback, event or RPC wiring`,
                    task.id,
                ),
            )
        }
    }
    return findings
}

// Mutation self-test: prove the vendored parser can distinguish a present
// declaration from an absent one, capture an import, and reject malformed
// syntax. It is intentionally independent from the target repository's files,
// package manager and tsconfig.
export async function selfTestAst() {
    const failures = []
    const valid = await scanTreeSitterSource({
        repoRoot: process.cwd(),
        filePath: "architecture-self-test.mjs",
        source: 'import { dependency } from "./dependency.mjs"\nexport function presentSymbol(){ return dependency() }\n',
    })
    const names = declarationNames(valid.facts, valid.file.path)
    if (!names.has("presentSymbol")) failures.push("present declaration was not captured")
    if (names.has("__absent_symbol__")) failures.push("absent declaration was invented")
    if (!valid.facts.some((fact) => fact.category === "imports" && fact.capture === "import.declaration")) {
        failures.push("runtime import was not captured")
    }
    const malformed = await scanTreeSitterSource({
        repoRoot: process.cwd(),
        filePath: "architecture-self-test.mjs",
        source: "export function broken(",
    })
    if (!syntaxFailed(malformed.diagnostics)) failures.push("malformed syntax produced no diagnostic")
    return {
        ok: failures.length === 0,
        message:
            failures.length === 0
                ? "vendored Tree-sitter mutation self-test detected declaration, import and syntax mutations"
                : failures.join("; "),
    }
}
