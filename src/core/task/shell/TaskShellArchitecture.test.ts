import path from "node:path"
import { Project, SyntaxKind } from "ts-morph"
import { describe, expect, it } from "vitest"

const ROOT = path.resolve(__dirname)
const project = new Project({
	tsConfigFilePath: path.resolve(ROOT, "../../../../tsconfig.json"),
	skipAddingFilesFromTsConfig: true,
})
project.addSourceFilesAtPaths(path.join(ROOT, "*.ts"))
const production = project.getSourceFiles().filter((source) => !source.getBaseName().endsWith(".test.ts"))

describe("TaskShell architecture", () => {
	it("keeps every shell production file below 1000 lines", () => {
		expect(
			production
				.map((source) => ({ file: source.getBaseName(), lines: source.getFullText().split(/\r?\n/).length }))
				.filter(({ lines }) => lines >= 1000),
		).toEqual([])
	})

	it("keeps constructors and dependency bundles bounded", () => {
		const oversizedConstructors = production.flatMap((source) =>
			source
				.getClasses()
				.flatMap((declaration) => declaration.getConstructors())
				.filter((constructor) => constructor.getParameters().length > 8)
				.map((constructor) => `${source.getBaseName()}:${constructor.getStartLineNumber()}`),
		)
		const oversizedBundles = production.flatMap((source) =>
			source
				.getInterfaces()
				.filter((declaration) => declaration.getName().endsWith("Ports"))
				.filter((declaration) => declaration.getProperties().length > 8)
				.map((declaration) => `${source.getBaseName()}:${declaration.getName()}`),
		)
		expect({ oversizedConstructors, oversizedBundles }).toEqual({ oversizedConstructors: [], oversizedBundles: [] })
	})

	it("exposes only the six task use cases on TaskShell", () => {
		const shell = project.getSourceFileOrThrow(path.join(ROOT, "TaskShell.ts")).getClassOrThrow("TaskShell")
		expect(
			shell
				.getMethods()
				.filter((method) => !method.hasModifier(SyntaxKind.PrivateKeyword))
				.map((method) => method.getName())
				.sort(),
		).toEqual(["cancel", "open", "respond", "start", "submitInput", "terminate"])
	})
})
