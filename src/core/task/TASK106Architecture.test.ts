import path from "node:path"
import { Project } from "ts-morph"
import { describe, expect, it } from "vitest"

const ROOT = path.resolve(__dirname)
const MODULES = [
	"stores",
	"resources",
	"subruntime",
	"collaboration",
	"intake",
	"executors/background",
	"executors/cotask",
	"executors/inbound",
]
const project = new Project({ tsConfigFilePath: path.resolve(ROOT, "../../../tsconfig.json"), skipAddingFilesFromTsConfig: true })
project.addSourceFilesAtPaths(MODULES.map((module) => path.join(ROOT, module, "**/*.ts")))
const production = project.getSourceFiles().filter((source) => !source.getBaseName().endsWith(".test.ts"))

describe("TASK-106 module architecture", () => {
	it("keeps new modules detached from production composition and legacy authorities", () => {
		const forbidden = [
			/core\/task\/index/,
			/\/controller\//,
			/\/proto\//,
			/webview-ui/,
			/core\/orchestrator/,
			/input-queue/,
			/TaskEffect/,
			/executors\/transitional/,
			/SubagentJobManager/,
			/BackgroundContextInjector/,
		]
		const violations = production
			.filter((source) => forbidden.some((pattern) => pattern.test(source.getFullText())))
			.map((source) => source.getFilePath())
		expect(violations).toEqual([])
	})

	it("keeps inbound executors free of child construction", () => {
		const sources = production.filter((source) => /executors[\\/](background|cotask)/.test(source.getFilePath()))
		expect(sources.filter((source) => /new\s+Task\b|SubruntimeSupervisor/.test(source.getFullText()))).toEqual([])
	})

	it("keeps every new production file below 1000 lines", () => {
		const oversized = production
			.map((source) => ({ file: source.getFilePath(), lines: source.getFullText().split(/\r?\n/).length }))
			.filter(({ lines }) => lines >= 1000)
		expect(oversized).toEqual([])
	})
})
