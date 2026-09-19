import { readFileSync } from "node:fs"
import path from "node:path"
import { Project } from "ts-morph"
import { describe, expect, it } from "vitest"

const TASK_ROOT = path.resolve(__dirname, "../..")
const ROOTS = [path.join(TASK_ROOT, "kernel"), path.join(TASK_ROOT, "shell"), path.join(TASK_ROOT, "view/v2")]
const project = new Project({
	tsConfigFilePath: path.resolve(TASK_ROOT, "../../../tsconfig.json"),
	skipAddingFilesFromTsConfig: true,
})
project.addSourceFilesAtPaths(ROOTS.map((root) => path.join(root, "**/*.ts")))

const production = project
	.getSourceFiles()
	.filter((source) => !source.getFilePath().includes("/__tests__/") && !source.getBaseName().endsWith(".test.ts"))

function normalized(filePath: string): string {
	return filePath.replaceAll("\\", "/")
}

describe("TASK-103 module architecture", () => {
	it("keeps new production files below the absolute 1000-line limit", () => {
		const oversized = production
			.map((source) => ({
				file: path.relative(TASK_ROOT, source.getFilePath()),
				lines: source.getFullText().split(/\r?\n/).length,
			}))
			.filter(({ lines }) => lines >= 1000)
		expect(oversized).toEqual([])
	})

	it("keeps shell and view-v2 dependencies directed toward kernel/stores", () => {
		const violations = production.flatMap((source) => {
			const sourcePath = normalized(source.getFilePath())
			return source.getImportDeclarations().flatMap((declaration) => {
				const resolved = declaration.getModuleSpecifierSourceFile()
				if (!resolved) return []
				const targetPath = normalized(resolved.getFilePath())
				if (sourcePath.includes("/view/v2/") && !targetPath.includes("/kernel/"))
					return [`${sourcePath} -> ${targetPath}`]
				if (
					sourcePath.includes("/shell/") &&
					!targetPath.includes("/kernel/") &&
					!targetPath.includes("/stores/") &&
					!targetPath.includes("/shell/")
				)
					return [`${sourcePath} -> ${targetPath}`]
				return []
			})
		})
		expect(violations).toEqual([])
	})

	it("keeps the kernel free of async and IO primitives", () => {
		const forbidden =
			/\b(?:Promise|Date|Math\.random|setTimeout|setInterval)\b|\b(?:fetch|readFile|writeFile|exec|spawn)\s*\(/
		const violations = production
			.filter((source) => normalized(source.getFilePath()).includes("/kernel/"))
			.filter((source) => forbidden.test(readFileSync(source.getFilePath(), "utf8")))
			.map((source) => path.relative(TASK_ROOT, source.getFilePath()))
		expect(violations).toEqual([])
	})
})
