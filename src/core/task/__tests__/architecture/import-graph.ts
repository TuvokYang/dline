import { readdirSync, readFileSync, statSync } from "node:fs"
import { builtinModules } from "node:module"
import path from "node:path"
import { ts } from "ts-morph"

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

const BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]))
const SOURCE_EXTENSION = /\.[cm]?[jt]sx?$/
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/

export function normalized(filePath: string): string {
	return filePath.replaceAll("\\", "/")
}

export function isUnder(candidate: string, root: string): boolean {
	const relative = path.relative(root, candidate)
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

export function productionFiles(roots: readonly string[]): string[] {
	const walk = (directory: string): string[] =>
		readdirSync(directory).flatMap((entry) => {
			const absolute = path.join(directory, entry)
			const normalizedPath = normalized(absolute)
			if (normalizedPath.includes("/__tests__/") || normalizedPath.includes("/__fixtures__/")) return []
			if (statSync(absolute).isDirectory()) return walk(absolute)
			return SOURCE_EXTENSION.test(entry) && !TEST_FILE.test(entry) ? [absolute] : []
		})
	return roots.flatMap(walk)
}

function literalText(node: ts.Node | undefined): string | undefined {
	return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined
}

function importBindings(node: ts.ImportDeclaration): ImportBinding[] {
	const clause = node.importClause
	if (!clause) return []
	const bindings: ImportBinding[] = []
	if (clause.name) {
		bindings.push({ imported: "default", local: clause.name.text, typeOnly: clause.isTypeOnly })
	}
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
	const record = (
		node: ts.Node,
		specifier: string | undefined,
		kind: ModuleReferenceKind,
		typeOnly: boolean,
		bindings: readonly ImportBinding[] = [],
	) => {
		if (!specifier) return
		references.push({
			specifier,
			kind,
			typeOnly,
			bindings,
			line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
		})
	}
	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node)) {
			const bindings = importBindings(node)
			record(
				node,
				literalText(node.moduleSpecifier),
				node.importClause ? "import" : "side_effect_import",
				Boolean(node.importClause) && bindings.every((binding) => binding.typeOnly),
				bindings,
			)
		} else if (ts.isExportDeclaration(node)) {
			const bindings = exportBindings(node)
			record(node, literalText(node.moduleSpecifier), "export", node.isTypeOnly, bindings)
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

function scriptKind(fileName: string): ts.ScriptKind {
	if (fileName.endsWith(".tsx")) return ts.ScriptKind.TSX
	if (fileName.endsWith(".jsx")) return ts.ScriptKind.JSX
	if (fileName.endsWith(".js") || fileName.endsWith(".mjs") || fileName.endsWith(".cjs")) return ts.ScriptKind.JS
	return ts.ScriptKind.TS
}

function compilerOptions(tsconfigPath: string): ts.CompilerOptions {
	const config = ts.readConfigFile(tsconfigPath, ts.sys.readFile)
	if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"))
	return ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(tsconfigPath)).options
}

function packageName(specifier: string): string {
	if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/")
	return specifier.split("/")[0]
}

function resolveTarget(specifier: string, importer: string, repoRoot: string, options: ts.CompilerOptions): ImportTarget {
	if (BUILTINS.has(specifier)) return { kind: "builtin", packageName: specifier.replace(/^node:/, "") }
	const resolved = ts.resolveModuleName(specifier, importer, options, ts.sys).resolvedModule?.resolvedFileName
	if (!resolved) {
		return specifier.startsWith(".") || specifier.startsWith("@/") || specifier.startsWith("@core/")
			? { kind: "unresolved" }
			: { kind: "package", packageName: packageName(specifier) }
	}
	const absolute = path.resolve(resolved.replace(/\.d\.[cm]?ts$/, ".ts"))
	if (isUnder(absolute, repoRoot)) {
		return { kind: "workspace", path: normalized(path.relative(repoRoot, absolute)), absolute }
	}
	return { kind: "package", packageName: packageName(specifier) }
}

export function scanImportGraph(options: ScanImportGraphOptions): readonly ImportEdge[] {
	const repoRoot = path.resolve(options.repoRoot)
	const parsedOptions = compilerOptions(options.tsconfigPath)
	return productionFiles(options.roots).flatMap((importerAbsolute) => {
		const importer = normalized(path.relative(repoRoot, importerAbsolute))
		return parseModuleReferences(readFileSync(importerAbsolute, "utf8"), importerAbsolute).map((reference) => ({
			...reference,
			importer,
			importerAbsolute,
			target: resolveTarget(reference.specifier, importerAbsolute, repoRoot, parsedOptions),
		}))
	})
}

export function edgeKey(edge: ImportEdge): string {
	const target = edge.target.kind === "workspace" ? edge.target.path : `${edge.target.kind}:${edge.specifier}`
	return `${edge.importer}:${edge.line} -> ${target}`
}
