import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { ts } from "ts-morph"
import { describe, expect, it } from "vitest"
import { TASK_101_FIELD_CLOSURE, TASK_101_FIELDS } from "./architecture/task-field-closure"

const REPO = path.resolve(__dirname, "../../../..")
const TASK_FACADE = path.join(REPO, "src/core/task/shell/Task.ts")
const COMPOSITION = path.join(REPO, "src/core/task/composition/TaskSessionCompositionService.ts")

function taskFacadeSurface(): { fields: string[]; methods: string[] } {
	const source = ts.createSourceFile(TASK_FACADE, readFileSync(TASK_FACADE, "utf8"), ts.ScriptTarget.Latest, true)
	const declaration = source.statements.find(
		(statement): statement is ts.ClassDeclaration => ts.isClassDeclaration(statement) && statement.name?.text === "Task",
	)
	if (!declaration) throw new Error("Task facade class not found")
	const fields = declaration.members.flatMap((member) => {
		if (ts.isPropertyDeclaration(member) && ts.isIdentifier(member.name)) return [member.name.text]
		if (!ts.isConstructorDeclaration(member)) return []
		return member.parameters.flatMap((parameter) => {
			const parameterProperty = parameter.modifiers?.some(
				(modifier) =>
					modifier.kind === ts.SyntaxKind.PublicKeyword ||
					modifier.kind === ts.SyntaxKind.ProtectedKeyword ||
					modifier.kind === ts.SyntaxKind.PrivateKeyword ||
					modifier.kind === ts.SyntaxKind.ReadonlyKeyword,
			)
			return parameterProperty && ts.isIdentifier(parameter.name) ? [parameter.name.text] : []
		})
	})
	const methods = declaration.members.flatMap((member) =>
		ts.isMethodDeclaration(member) && ts.isIdentifier(member.name) ? [member.name.text] : [],
	)
	return { fields: fields.sort(), methods: methods.sort() }
}

describe("TASK-107 closure of the TASK-101 field inventory", () => {
	it("accounts for all 109 activation-baseline fields exactly once", () => {
		expect(TASK_101_FIELDS).toHaveLength(109)
		expect(new Set(TASK_101_FIELDS).size).toBe(109)
		expect(
			TASK_101_FIELD_CLOSURE.every(
				({ owner, evidence, fields }) => owner.length > 0 && evidence.length > 0 && fields.length > 0,
			),
		).toBe(true)
	})

	it("keeps every final-owner evidence path present", () => {
		const missing = TASK_101_FIELD_CLOSURE.flatMap(({ owner, evidence }) =>
			evidence.filter((relative) => !existsSync(path.join(REPO, relative))).map((relative) => `${owner}: ${relative}`),
		)
		expect(missing).toEqual([])
	})

	it("keeps the production Task as the six-use-case facade rather than regrowing baseline fields", () => {
		expect(taskFacadeSurface()).toEqual({
			fields: ["components", "taskId"],
			methods: ["cancel", "open", "respond", "start", "submitInput", "terminate"],
		})
	})

	it("requires every performance owner to be constructed by the production composition root", () => {
		const source = readFileSync(COMPOSITION, "utf8")
		const required = TASK_101_FIELD_CLOSURE.flatMap(({ requiredCompositionSymbols = [] }) => requiredCompositionSymbols)
		const missing = required.filter((symbol) => !source.includes(symbol))
		expect(missing).toEqual([])
	})
})
