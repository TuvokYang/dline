import { readdirSync, readFileSync } from "node:fs"
import { builtinModules } from "node:module"
import path from "node:path"
import { ts } from "ts-morph"

const BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]))
const SOURCE_EXTENSION = /\.[cm]?[jt]sx?$/
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/

export type ModuleReferenceKind =
    | "import"
    | "side_effect_import"
    | "export"
    | "import_equals"
    | "import_type"
    | "dynamic_import"
    | "require"

export interface ImportBinding {
    readonly imported: string
    readonly local?: string
    readonly typeOnly: boolean
}

export interface ParsedModuleReference {
    readonly specifier: string
    readonly kind: ModuleReferenceKind
    readonly typeOnly: boolean
    readonly bindings: readonly ImportBinding[]
    readonly line: number
}

export type ImportTarget =
    | { readonly kind: "workspace"; readonly path: string; readonly absolute: string }
    | { readonly kind: "builtin"; readonly packageName: string }
    | { readonly kind: "package"; readonly packageName: string }
    | { readonly kind: "unresolved" }

export interface ImportEdge extends ParsedModuleReference {
    readonly importer: string
    readonly importerAbsolute: string
    readonly target: ImportTarget
}

export interface ScanImportGraphOptions {
    readonly repoRoot: string
    readonly tsconfigPath: string
    readonly roots: readonly string[]
}

export function normalized(filePath: string): string {
    return filePath.replaceAll("\\", "/")
}

export function isUnder(candidate: string, root: string): boolean {
    const relative = path.relative(root, candidate)
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

export function productionFiles(roots: readonly string[]): string[] {
    const seen = new Set<string>()
    const files: string[] = []
    const walk = (directory: string) => {
        for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
            left.name.localeCompare(right.name),
        )) {
            const absolute = path.join(directory, entry.name)
            const normalizedPath = normalized(absolute)
            if (normalizedPath.includes("/__tests__/") || normalizedPath.includes("/__fixtures__/")) continue
            if (entry.isDirectory()) {
                walk(absolute)
                continue
            }
            if (!entry.isFile() || !SOURCE_EXTENSION.test(entry.name) || TEST_FILE.test(entry.name)) continue
            const resolved = path.resolve(absolute)
            if (seen.has(resolved)) continue
            seen.add(resolved)
            files.push(resolved)
        }
    }
    for (const root of roots) walk(path.resolve(root))
    return files.sort((left, right) => normalized(left).localeCompare(normalized(right)))
}

function scriptKind(fileName: string): ts.ScriptKind {
    if (fileName.endsWith(".tsx")) return ts.ScriptKind.TSX
    if (fileName.endsWith(".jsx")) return ts.ScriptKind.JSX
    if (fileName.endsWith(".js") || fileName.endsWith(".mjs") || fileName.endsWith(".cjs")) return ts.ScriptKind.JS
    return ts.ScriptKind.TS
}

function literalText(node: ts.Node | undefined): string | undefined {
    return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined
}

function importBindings(node: ts.ImportDeclaration): ImportBinding[] {
    const clause = node.importClause
    if (!clause) return []
    const bindings: ImportBinding[] = []
    if (clause.name) bindings.push({ imported: "default", local: clause.name.text, typeOnly: clause.isTypeOnly })
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        bindings.push({ imported: "*", local: clause.namedBindings.name.text, typeOnly: clause.isTypeOnly })
    }
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
            bindings.push({
                imported: element.propertyName?.text ?? element.name.text,
                local: element.name.text,
                typeOnly: clause.isTypeOnly || element.isTypeOnly,
            })
        }
    }
    return bindings
}

function exportBindings(node: ts.ExportDeclaration): ImportBinding[] {
    if (!node.exportClause || !ts.isNamedExports(node.exportClause)) return []
    return node.exportClause.elements.map((element) => ({
        imported: element.propertyName?.text ?? element.name.text,
        local: element.name.text,
        typeOnly: node.isTypeOnly || element.isTypeOnly,
    }))
}

export function parseModuleReferences(source: string, fileName = "source.ts"): readonly ParsedModuleReference[] {
    const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind(fileName))
    const references: ParsedModuleReference[] = []
    const lineOf = (node: ts.Node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
    const record = (
        node: ts.Node,
        specifier: string | undefined,
        kind: ModuleReferenceKind,
        typeOnly: boolean,
        bindings: readonly ImportBinding[] = [],
    ) => {
        if (specifier) references.push({ specifier, kind, typeOnly, bindings, line: lineOf(node) })
    }
    const visit = (node: ts.Node) => {
        if (ts.isImportDeclaration(node)) {
            const bindings = importBindings(node)
            const typeOnly =
                Boolean(node.importClause) &&
                (Boolean(node.importClause?.isTypeOnly) || (bindings.length > 0 && bindings.every((binding) => binding.typeOnly)))
            record(
                node,
                literalText(node.moduleSpecifier),
                node.importClause ? "import" : "side_effect_import",
                typeOnly,
                bindings,
            )
        } else if (ts.isExportDeclaration(node)) {
            const bindings = exportBindings(node)
            const typeOnly = Boolean(node.isTypeOnly) || (bindings.length > 0 && bindings.every((binding) => binding.typeOnly))
            record(node, literalText(node.moduleSpecifier), "export", typeOnly, bindings)
        } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
            record(node, literalText(node.moduleReference.expression), "import_equals", node.isTypeOnly, [
                { imported: "*", local: node.name.text, typeOnly: node.isTypeOnly },
            ])
        } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
            record(node, literalText(node.argument.literal), "import_type", true)
        } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
            record(node, literalText(node.arguments[0]), "dynamic_import", false)
        } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") {
            record(node, literalText(node.arguments[0]), "require", false)
        }
        ts.forEachChild(node, visit)
    }
    visit(sourceFile)
    return references
}

function readCompilerOptions(tsconfigPath: string): ts.CompilerOptions {
    const config = ts.readConfigFile(tsconfigPath, ts.sys.readFile)
    if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"))
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(tsconfigPath), undefined, tsconfigPath)
    if (parsed.errors.length > 0) {
        throw new Error(parsed.errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("; "))
    }
    return parsed.options
}

function packageName(specifier: string): string {
    if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/")
    return specifier.split("/")[0]
}

function resolveTarget(specifier: string, importer: string, repoRoot: string, compilerOptions: ts.CompilerOptions): ImportTarget {
    if (BUILTINS.has(specifier)) return { kind: "builtin", packageName: specifier.replace(/^node:/, "") }
    const resolution = ts.resolveModuleName(specifier, importer, compilerOptions, ts.sys).resolvedModule
    if (!resolution)
        return specifier.startsWith(".") ? { kind: "unresolved" } : { kind: "package", packageName: packageName(specifier) }
    const absolute = path.resolve(resolution.resolvedFileName)
    if (resolution.isExternalLibraryImport || !isUnder(absolute, repoRoot)) {
        return { kind: "package", packageName: packageName(specifier) }
    }
    return { kind: "workspace", path: normalized(path.relative(repoRoot, absolute)), absolute }
}

export function scanSourceFiles(
    options: Omit<ScanImportGraphOptions, "roots">,
    sourceFiles: readonly string[],
): readonly ImportEdge[] {
    const repoRoot = path.resolve(options.repoRoot)
    const compilerOptions = readCompilerOptions(options.tsconfigPath)
    const edges: ImportEdge[] = []
    for (const importerAbsolute of [...new Set(sourceFiles.map((file) => path.resolve(file)))].sort()) {
        const importer = normalized(path.relative(repoRoot, importerAbsolute))
        for (const reference of parseModuleReferences(readFileSync(importerAbsolute, "utf8"), importerAbsolute)) {
            edges.push({
                ...reference,
                importer,
                importerAbsolute,
                target: resolveTarget(reference.specifier, importerAbsolute, repoRoot, compilerOptions),
            })
        }
    }
    return edges.sort(
        (left, right) =>
            left.importer.localeCompare(right.importer) ||
            left.line - right.line ||
            left.kind.localeCompare(right.kind) ||
            left.specifier.localeCompare(right.specifier),
    )
}

export function scanImportGraph(options: ScanImportGraphOptions): readonly ImportEdge[] {
    return scanSourceFiles(options, productionFiles(options.roots))
}

export function edgeKey(edge: ImportEdge): string {
    const target = edge.target.kind === "workspace" ? edge.target.path : `${edge.target.kind}:${edge.specifier}`
    return `${edge.importer}:${edge.line} -> ${target}`
}
