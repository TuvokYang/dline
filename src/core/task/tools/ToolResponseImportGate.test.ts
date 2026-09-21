import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const TASK_ROOT = path.resolve(__dirname, "..")

function productionFiles(directory: string): string[] {
	return readdirSync(directory).flatMap((entry) => {
		const absolute = path.join(directory, entry)
		if (statSync(absolute).isDirectory()) return productionFiles(absolute)
		return /\.ts$/.test(entry) && !entry.endsWith(".test.ts") ? [absolute] : []
	})
}

describe("ToolResponse import boundary", () => {
	it("keeps ToolResponse consumers on the leaf type instead of the task barrel", () => {
		const violations = productionFiles(TASK_ROOT)
			.filter((file) => readFileSync(file, "utf8").includes("ToolResponse"))
			.filter((file) => file !== path.join(TASK_ROOT, "index.ts"))
			.filter((file) => {
				const source = readFileSync(file, "utf8")
				return /ToolResponse[^\n]*from ["'](?:@core\/task|(?:\.\.\/)+(?:index)?)["']/.test(source)
			})
			.map((file) => path.relative(TASK_ROOT, file).replaceAll("\\", "/"))
		expect(violations).toEqual([])
	})
})
