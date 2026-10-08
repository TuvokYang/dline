import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Controller } from "@core/controller"
import { CreateInputTextResourceRequest } from "@shared/proto/dline/task"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const previousDocumentsDir = process.env.DLINE_DOCS_DIR

beforeAll(() => {
	process.env.DLINE_DOCS_DIR = mkdtempSync(path.join(tmpdir(), "dline-paste-resource-"))
})

afterAll(() => {
	if (previousDocumentsDir === undefined) delete process.env.DLINE_DOCS_DIR
	else process.env.DLINE_DOCS_DIR = previousDocumentsDir
})

function controllerWithTask(taskId: string | undefined): Controller {
	return { task: taskId === undefined ? undefined : { taskId } } as unknown as Controller
}

function oversizedText(): string {
	return Array.from({ length: 24 }, (_, line) => `log line ${line}`).join("\n")
}

async function invoke(controller: Controller, request: CreateInputTextResourceRequest) {
	const { createInputTextResource } = await import("../createInputTextResource")
	return await createInputTextResource(controller, request)
}

describe("createInputTextResource", () => {
	it("stores an oversized paste as a file owned by the active task", async () => {
		const text = oversizedText()

		const response = await invoke(controllerWithTask("paste-owner"), CreateInputTextResourceRequest.create({ text }))

		expect(response.created).toBe(true)
		expect(response.result).toBe("created")
		expect(response.absolutePath).toContain(path.join("tasks", "paste-owner", "tmp", "input-resources"))
		expect(readFileSync(response.absolutePath ?? "", "utf8")).toBe(text)
		expect(response.lineCount).toBe(24)
	})

	it("keeps text inline when no task owns the input yet", async () => {
		const response = await invoke(
			controllerWithTask(undefined),
			CreateInputTextResourceRequest.create({ text: oversizedText() }),
		)

		expect(response.created).toBe(false)
		expect(response.result).toBe("missing_task")
	})

	it("keeps text inline when it still fits the inline budget", async () => {
		const response = await invoke(
			controllerWithTask("paste-small"),
			CreateInputTextResourceRequest.create({ text: "one\ntwo" }),
		)

		expect(response.created).toBe(false)
		expect(response.result).toBe("within_inline_budget")
	})

	it("ignores a caller-supplied extension that is not a plain extension", async () => {
		const response = await invoke(
			controllerWithTask("paste-extension"),
			CreateInputTextResourceRequest.create({ text: oversizedText(), extension: "../../escape" }),
		)

		expect(response.created).toBe(true)
		expect(response.displayName).toMatch(/\.txt$/)
	})
})
