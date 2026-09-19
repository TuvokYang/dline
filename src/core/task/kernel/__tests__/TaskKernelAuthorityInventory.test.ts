import path from "node:path"
import { type CallExpression, Project, SyntaxKind } from "ts-morph"
import { describe, expect, it } from "vitest"

const ROOT = path.resolve(__dirname, "../../../../..")
const project = new Project({ tsConfigFilePath: path.join(ROOT, "tsconfig.json"), skipAddingFilesFromTsConfig: true })
project.addSourceFilesAtPaths([
	path.join(ROOT, "src/core/task/**/*.ts"),
	path.join(ROOT, "src/core/controller/task/explainChanges.ts"),
])

const productionFiles = project
	.getSourceFiles()
	.filter((source) => !source.getFilePath().includes("/__tests__/") && !source.getBaseName().endsWith(".test.ts"))

function relative(sourcePath: string): string {
	return path.relative(ROOT, sourcePath).replaceAll("\\", "/")
}

function calledFiles(method: string, expressionFilter?: (text: string) => boolean): string[] {
	const files = new Set<string>()
	for (const source of productionFiles) {
		for (const call of source.getDescendantsOfKind(SyntaxKind.CallExpression)) {
			const expression = (call as CallExpression).getExpression()
			if (!expression.isKind(SyntaxKind.PropertyAccessExpression) || expression.getName() !== method) continue
			if (expressionFilter && !expressionFilter(expression.getExpression().getText())) continue
			files.add(relative(source.getFilePath()))
		}
	}
	return [...files].sort()
}

function taskStateAbortFiles(): string[] {
	const files = new Set<string>()
	for (const source of productionFiles) {
		for (const access of source.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
			if (access.getName() !== "abort") continue
			if (!/(?:^|\.)taskState$/.test(access.getExpression().getText())) continue
			files.add(relative(source.getFilePath()))
		}
	}
	return [...files].sort()
}

describe("TASK-103 legacy authority migration inventory", () => {
	it("freezes legacy machine and restore write-call files for TASK-107", () => {
		expect({
			transitionRequired: calledFiles("transitionRequired"),
			buildTurn: calledFiles("buildTurn"),
			advance: calledFiles("advance"),
			rejectActiveBlock: calledFiles("rejectActiveBlock"),
			completeActiveBlock: calledFiles("completeActiveBlock"),
			restoreTurnFromSnapshot: calledFiles("restoreTurnFromSnapshot"),
			syncRetainedMachines: calledFiles("syncRetainedMachines"),
			taskRuntimeRestore: calledFiles("restore", (text) => text.endsWith("taskRuntime")),
		}).toEqual({
			transitionRequired: ["src/core/task/RestoreHandler.ts", "src/core/task/index.ts"],
			buildTurn: [
				"src/core/task/RestoreHandler.ts",
				"src/core/task/TaskController.ts",
				"src/core/task/executors/tool/TurnDriver.ts",
				"src/core/task/index.ts",
			],
			advance: ["src/core/task/BlockPhaseMachine.ts", "src/core/task/TaskController.ts"],
			rejectActiveBlock: ["src/core/task/TaskController.ts", "src/core/task/index.ts"],
			completeActiveBlock: ["src/core/task/TaskController.ts", "src/core/task/index.ts"],
			restoreTurnFromSnapshot: ["src/core/task/RestoreHandler.ts", "src/core/task/index.ts"],
			syncRetainedMachines: ["src/core/task/index.ts"],
			taskRuntimeRestore: ["src/core/task/index.ts"],
		})
	})

	it("freezes every production taskState.abort consumer file for TASK-107", () => {
		expect(taskStateAbortFiles()).toEqual([
			"src/core/controller/task/explainChanges.ts",
			"src/core/task/MessageChannel.ts",
			"src/core/task/ToolExecutor.ts",
			"src/core/task/index.ts",
			"src/core/task/tools/handlers/GenerateExplanationToolHandler.ts",
			"src/core/task/tools/handlers/SpawnTaskHandler.ts",
			"src/core/task/tools/subagent/SubagentRunner.ts",
			"src/core/task/tools/utils/ToolHookUtils.ts",
		])
	})
})
