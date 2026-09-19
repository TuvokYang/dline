import path from "node:path"
import { Project } from "ts-morph"
import { describe, expect, it } from "vitest"

const ROOT = path.resolve(__dirname)
const DOMAINS = ["provider", "compose", "compaction", "tool", "dialog", "policy", "halt", "spawn"]
const project = new Project({
	tsConfigFilePath: path.resolve(ROOT, "../../../../tsconfig.json"),
	skipAddingFilesFromTsConfig: true,
})
project.addSourceFilesAtPaths(DOMAINS.map((domain) => path.join(ROOT, domain, "**/*.ts")))

const production = project
	.getSourceFiles()
	.filter((source) => !source.getBaseName().endsWith(".test.ts") && !source.getFilePath().includes("/__tests__/"))

function domainOf(filePath: string): string | undefined {
	return DOMAINS.find((domain) => filePath.replaceAll("\\", "/").includes(`/executors/${domain}/`))
}

describe("TASK-105 executor architecture", () => {
	it("keeps executor domains free of mutual imports", () => {
		const violations = production.flatMap((source) => {
			const sourceDomain = domainOf(source.getFilePath())
			return source.getImportDeclarations().flatMap((declaration) => {
				const resolved = declaration.getModuleSpecifierSourceFile()
				const targetDomain = resolved ? domainOf(resolved.getFilePath()) : undefined
				return sourceDomain && targetDomain && sourceDomain !== targetDomain
					? [`${source.getBaseName()}:${sourceDomain}->${targetDomain}`]
					: []
			})
		})
		expect(violations).toEqual([])
	})

	it("does not let command executors read kernel state or import production composition surfaces", () => {
		const commandExecutors = production.filter((source) =>
			/CommandExecutor\.ts$|SpawnCoordinator\.ts$/.test(source.getBaseName()),
		)
		const forbidden = [/\bgetState\s*\(/, /(?:^|\/)core\/task(?:\/index)?["']/, /\/controller\//, /\/proto\//, /webview-ui/]
		const violations = commandExecutors
			.filter((source) => forbidden.some((pattern) => pattern.test(source.getFullText())))
			.map((source) => source.getBaseName())
		expect(violations).toEqual([])
	})

	it("keeps one WS-072 scheduler and one kernel tool adapter", () => {
		const classes = production.flatMap((source) => source.getClasses().map((declaration) => declaration.getName()))
		expect(classes.filter((name) => name === "TurnToolScheduler")).toHaveLength(1)
		expect(classes.filter((name) => name === "ToolCommandExecutor")).toHaveLength(1)
	})

	it("keeps every executor production file below 1000 lines", () => {
		const oversized = production
			.map((source) => ({ file: source.getBaseName(), lines: source.getFullText().split(/\r?\n/).length }))
			.filter(({ lines }) => lines >= 1000)
		expect(oversized).toEqual([])
	})
})
