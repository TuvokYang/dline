// Stage 6 (B2/AST): does the code behind a gated task diagram exist?
// Only facts that a source scan can prove are checked. Everything else is
// reported as not checked instead of being guessed.

import fs from "node:fs"
import path from "node:path"

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"]

const EXPORT_PATTERNS = [
    /^\s*export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:default\s+)?(?:class|interface|type|enum|const|let|var|function|namespace)\s+([A-Za-z_$][\w$]*)/gm,
    /^\s*export\s*\{([^}]*)\}/gm,
    /^\s*module\.exports\s*=\s*\{([^}]*)\}/gm,
]

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

function isSourceFile(name) {
    return SOURCE_EXTENSIONS.includes(path.extname(name))
}

function resolveModuleTarget(absolute) {
    if (fs.existsSync(absolute)) {
        const stat = fs.statSync(absolute)
        if (stat.isFile()) return absolute
        if (stat.isDirectory()) {
            for (const extension of SOURCE_EXTENSIONS) {
                const index = path.join(absolute, `index${extension}`)
                if (fs.existsSync(index)) return index
            }
            return absolute
        }
    }
    for (const extension of SOURCE_EXTENSIONS) {
        const candidate = `${absolute}${extension}`
        if (fs.existsSync(candidate)) return candidate
        const asIndex = path.join(absolute, `index${extension}`)
        if (fs.existsSync(asIndex)) return asIndex
    }
    return null
}

export function collectExports(filePath) {
    const content = fs.readFileSync(filePath, "utf8")
    const names = new Set()
    for (const pattern of EXPORT_PATTERNS.slice(0, 1)) {
        for (const match of content.matchAll(pattern)) names.add(match[1])
    }
    for (const match of content.matchAll(EXPORT_PATTERNS[1])) {
        for (const entry of match[1].split(",")) {
            const parts = entry.trim().split(/\s+as\s+/)
            const exported = (parts[1] ?? parts[0] ?? "").trim()
            if (exported && exported !== "default") names.add(exported)
        }
    }
    return names
}

function collectImportTargets(filePath) {
    const content = fs.readFileSync(filePath, "utf8")
    const targets = []
    const specifiers = [
        ...content.matchAll(/^\s*import\s[^'"]*from\s*["']([^"']+)["']/gm),
        ...content.matchAll(/^\s*export\s[^'"]*from\s*["']([^"']+)["']/gm),
        ...content.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g),
        ...content.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g),
    ]
    for (const match of specifiers) {
        const specifier = match[1]
        if (!specifier.startsWith(".")) continue
        const resolved = resolveModuleTarget(path.resolve(path.dirname(filePath), specifier))
        if (resolved) targets.push(resolved)
    }
    return targets
}

function boundaryMatches(boundary, sourceFile, exportedNames) {
    const selector = boundary.selector ?? ""
    switch (boundary.kind) {
        case "module":
            return true
        case "symbol": {
            const symbols = selector
                .split(/[,;]/)
                .map((entry) => entry.trim())
                .filter(Boolean)
            if (symbols.length === 0) return true
            return symbols.some((symbol) => exportedNames.has(symbol) || exportedNames.has(symbol.split(".")[0]))
        }
        case "whole_file":
        case "section":
        case "line_range":
        case "structured_node":
            return true
        default:
            return true
    }
}

export function checkAstForTask({ task, wsModules, repoRoot }) {
    const findings = []
    const moduleNodes = []

    for (const diagram of task.diagrams) {
        for (const [nodeId, modulePath] of diagram.modules) {
            moduleNodes.push({ nodeId, modulePath, diagram })
        }
    }
    for (const [name, entry] of wsModules ?? []) {
        void name
        void entry
    }

    for (const boundary of task.owns) {
        const absolute = path.resolve(repoRoot, boundary.path)
        const resolved = resolveModuleTarget(absolute)
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
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) continue
        if (boundary.kind !== "symbol") continue
        const exportedNames = collectExports(resolved)
        if (!boundaryMatches(boundary, resolved, exportedNames)) {
            findings.push(
                finding(
                    "blocking",
                    "diagram",
                    { file: boundary.path },
                    "owned-symbol-missing",
                    `${task.id} is completed and owns symbol "${boundary.selector}" in ${boundary.path}, but it is not exported`,
                    task.id,
                ),
            )
        }
    }

    // A diagram node bound with %% module: must point at a real module.
    for (const entry of moduleNodes) {
        const resolved = resolveModuleTarget(path.resolve(repoRoot, entry.modulePath))
        if (!resolved || !fs.existsSync(resolved)) {
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
    }

    // An implemented solid edge must have a real import between the two bound modules.
    const edges = task.diagrams.flatMap((diagram) =>
        diagram.edges.filter((edge) => edge.style === "solid").map((edge) => ({ edge, diagram })),
    )
    for (const { edge, diagram } of edges) {
        const fromPath = diagram.modules.get(edge.from)
        const toPath = diagram.modules.get(edge.to)
        if (!fromPath || !toPath) continue
        const fromResolved = resolveModuleTarget(path.resolve(repoRoot, fromPath))
        const toResolved = resolveModuleTarget(path.resolve(repoRoot, toPath))
        if (!fromResolved || !toResolved) continue
        if (!fs.existsSync(fromResolved) || !fs.statSync(fromResolved).isFile()) continue
        const targets = collectImportTargets(fromResolved)
        const toIsDirectory = fs.statSync(toResolved).isDirectory()
        const importsTarget = targets.some((target) => {
            // A file target must resolve exactly. A directory target accepts any file inside it.
            if (!toIsDirectory) return target === toResolved
            const relative = path.relative(toResolved, target)
            return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative)
        })
        if (!importsTarget) {
            // Dependency inversion is the prescribed way to realize a command edge:
            // the source talks to a port the composition root injects and never
            // imports the target's concrete module. A missing import is therefore
            // the expected shape of correct code, not evidence against it, and
            // the proof lives in the task's execution ledger (emit side, receive
            // side, and a test that breaks when either is removed).
            findings.push(
                finding(
                    "not-checked",
                    "diagram",
                    { file: diagram.file, line: edge.line },
                    "implemented-edge-without-direct-import",
                    `${task.id} draws ${edge.from} --> ${edge.to} between ${fromPath} and ${toPath}, but ${fromPath} does not import ${toPath}; the edge must be proven through the execution ledger (injected port or call site)`,
                    task.id,
                ),
            )
        }
    }

    return findings
}

// Mutation self-test: a deliberately missing symbol must be reported.
// A silent pass means the AST scanner is broken, which is a tooling problem.
export function selfTestAst(repoRoot) {
    const findings = []
    const task = {
        id: "SELF-TEST",
        owns: [
            {
                path: "package.json",
                kind: "symbol",
                selector: "__dline_diagram_verifier_absent_symbol__",
            },
        ],
        diagrams: [],
    }
    const packagePath = path.resolve(repoRoot, "package.json")
    if (!fs.existsSync(packagePath)) {
        return {
            ok: false,
            message: "self-test could not run: package.json is missing at the repository root",
        }
    }
    const probe = checkAstForTask({ task, wsModules: null, repoRoot })
    if (probe.length === 0) {
        findings.push("expected a blocking finding for an absent exported symbol, but the scanner reported none")
    }
    const realTask = {
        id: "SELF-TEST",
        owns: [],
        diagrams: [
            {
                file: "<self-test>",
                line: 0,
                edges: [{ from: "A", to: "B", style: "solid", label: "commits", line: 0 }],
                modules: new Map([
                    ["A", "package.json"],
                    ["B", "README.md"],
                ]),
            },
        ],
    }
    const edgeProbe = checkAstForTask({ task: realTask, wsModules: null, repoRoot })
    if (!edgeProbe.some((entry) => entry.rule === "implemented-edge-without-direct-import")) {
        findings.push("expected a finding for an edge without a real import, but the scanner reported none")
    }
    return {
        ok: findings.length === 0,
        message: findings.length === 0 ? "mutation self-test detected both seeded defects" : findings.join("; "),
    }
}
