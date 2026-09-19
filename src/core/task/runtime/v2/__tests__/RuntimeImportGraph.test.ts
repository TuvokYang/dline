import { readFileSync } from "node:fs"
import path from "node:path"
import { Project, type SourceFile, SyntaxKind } from "ts-morph"
import { describe, expect, it } from "vitest"

const REPO = path.resolve(__dirname, "../../../../../..")
const TARGETS = [
	"src/core/task/kernel/**/*.ts",
	"src/core/task/runtime/v2/**/*.ts",
	"src/core/task/stores/**/*.ts",
	"src/core/task/executors/transitional/**/*.ts",
]

type Layer = "kernel" | "runtime" | "stores" | "transitional"

function layerOf(filePath: string): Layer {
	const normalized = filePath.replaceAll("\\", "/")
	if (normalized.includes("/kernel/")) return "kernel"
	if (normalized.includes("/runtime/v2/")) return "runtime"
	if (normalized.includes("/stores/")) return "stores"
	return "transitional"
}

function productionFiles(): SourceFile[] {
	const project = new Project({ tsConfigFilePath: path.join(REPO, "tsconfig.json"), skipAddingFilesFromTsConfig: true })
	project.addSourceFilesAtPaths(TARGETS.map((pattern) => path.join(REPO, pattern).replaceAll("\\", "/")))
	return project.getSourceFiles().filter((file) => !file.getFilePath().replaceAll("\\", "/").includes("/__tests__/"))
}

function dependencies(file: SourceFile): SourceFile[] {
	const imported = file
		.getImportDeclarations()
		.map((declaration) => declaration.getModuleSpecifierSourceFile())
		.filter((dependency): dependency is SourceFile => dependency !== undefined)
	const exported = file
		.getExportDeclarations()
		.map((declaration) => declaration.getModuleSpecifierSourceFile())
		.filter((dependency): dependency is SourceFile => dependency !== undefined)
	return Array.from(new Set([...imported, ...exported]))
}

function cycles(files: readonly SourceFile[]): string[][] {
	const target = new Set<string>(files.map((file) => String(file.getFilePath())))
	const graph = new Map<string, string[]>(
		files.map((file) => [
			String(file.getFilePath()),
			dependencies(file)
				.map((dependency) => String(dependency.getFilePath()))
				.filter((dependency) => target.has(dependency)),
		]),
	)
	const visiting = new Set<string>()
	const visited = new Set<string>()
	const stack: string[] = []
	const found: string[][] = []

	function visit(file: string): void {
		if (visiting.has(file)) {
			const start = stack.indexOf(file)
			found.push([...stack.slice(start), file].map((entry) => path.relative(REPO, entry).replaceAll("\\", "/")))
			return
		}
		if (visited.has(file)) return
		visiting.add(file)
		stack.push(file)
		for (const dependency of graph.get(file) ?? []) visit(dependency)
		stack.pop()
		visiting.delete(file)
		visited.add(file)
	}

	for (const file of graph.keys()) visit(file)
	return found
}

const FILES = productionFiles()

describe("runtime v2 import graph", () => {
	it("keeps dependencies directional and resolved", () => {
		const allowed: Record<Layer, readonly Layer[]> = {
			kernel: ["kernel"],
			stores: ["kernel", "stores"],
			runtime: ["kernel", "stores", "runtime"],
			transitional: ["kernel", "runtime", "transitional"],
		}
		const violations = FILES.flatMap((file) => {
			const sourceLayer = layerOf(file.getFilePath())
			const allowedLayers = allowed[sourceLayer] ?? []
			return dependencies(file)
				.filter((dependency) => !allowedLayers.includes(layerOf(dependency.getFilePath())))
				.map((dependency) => ({
					source: path.relative(REPO, file.getFilePath()),
					dependency: path.relative(REPO, dependency.getFilePath()),
				}))
		})
		expect(violations).toEqual([])
	})

	it("contains no unresolved relative, dynamic or require import", () => {
		const violations = FILES.flatMap((file) => {
			const unresolved = [...file.getImportDeclarations(), ...file.getExportDeclarations()]
				.map((declaration) => ({
					specifier: declaration.getModuleSpecifierValue(),
					resolved: declaration.getModuleSpecifierSourceFile(),
				}))
				.filter(
					(entry): entry is { specifier: string; resolved: undefined } =>
						typeof entry.specifier === "string" && entry.specifier.startsWith(".") && !entry.resolved,
				)
				.map((entry) => entry.specifier)
			const dynamic = file
				.getDescendantsOfKind(SyntaxKind.CallExpression)
				.filter(
					(call) =>
						call.getExpression().getKind() === SyntaxKind.ImportKeyword ||
						call.getExpression().getText() === "require",
				)
				.map((call) => call.getText())
			return [...unresolved, ...dynamic].map((specifier) => ({ file: path.relative(REPO, file.getFilePath()), specifier }))
		})
		expect(violations).toEqual([])
	})

	it("contains no dependency cycle", () => {
		expect(cycles(FILES)).toEqual([])
	})

	it("keeps EventLoop free of await and all new production files below 1000 lines", () => {
		const files = FILES
		const eventLoop = files.find((file) => file.getBaseName() === "EventLoop.ts")
		expect(eventLoop?.getDescendantsOfKind(SyntaxKind.AwaitExpression)).toEqual([])
		const oversized = files
			.map((file) => ({
				file: path.relative(REPO, file.getFilePath()).replaceAll("\\", "/"),
				lines: readFileSync(file.getFilePath(), "utf8").split(/\r?\n/).length,
			}))
			.filter((entry) => entry.lines >= 1000)
		expect(oversized).toEqual([])
	})
})
