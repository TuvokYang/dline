import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const ROOT = path.resolve(__dirname, "..")

function productionFiles(directory: string): string[] {
	return readdirSync(directory).flatMap((entry) => {
		const absolute = path.join(directory, entry)
		if (entry === "__tests__") return []
		return statSync(absolute).isDirectory() ? productionFiles(absolute) : entry.endsWith(".ts") ? [absolute] : []
	})
}

function imports(source: string): string[] {
	const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1")
	return Array.from(stripped.matchAll(/\b(?:from\s*|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g), (match) => match[1])
}

describe("task kernel import graph", () => {
	it("contains no package-external production import", () => {
		const violations = productionFiles(ROOT).flatMap((file) =>
			imports(readFileSync(file, "utf8"))
				.filter((specifier) => !specifier.startsWith("."))
				.map((specifier) => ({ file: path.relative(ROOT, file), specifier })),
		)
		expect(violations).toEqual([])
	})

	it("contains no async, clock, random or IO primitive", () => {
		const forbidden =
			/\b(?:Promise|Date|Math\.random|setTimeout|setInterval)\b|\b(?:fetch|readFile|writeFile|exec|spawn)\s*\(/
		const violations = productionFiles(ROOT)
			.filter((file) => forbidden.test(readFileSync(file, "utf8")))
			.map((file) => path.relative(ROOT, file))
		expect(violations).toEqual([])
	})
})
