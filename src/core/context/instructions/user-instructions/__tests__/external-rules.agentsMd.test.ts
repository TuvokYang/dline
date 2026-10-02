import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@core/prompts/responses", () => ({
	formatResponse: {
		// Return the combined body so the test can assert which files were read.
		agentsRulesLocalFileInstructions: (_cwd: string, content: string) => content,
	},
}))

const { getLocalAgentsRules } = await import("../external-rules")

const workspaces: string[] = []

async function createWorkspace(files: Record<string, string>): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "agents-md-"))
	workspaces.push(root)
	for (const [relativePath, content] of Object.entries(files)) {
		const target = path.join(root, relativePath)
		await fs.mkdir(path.dirname(target), { recursive: true })
		await fs.writeFile(target, content, "utf8")
	}
	return root
}

afterEach(async () => {
	await Promise.all(workspaces.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe("getLocalAgentsRules", () => {
	it("reads only the workspace-root AGENTS.md", async () => {
		const cwd = await createWorkspace({
			"AGENTS.md": "root guidance",
			"packages/api/AGENTS.md": "api guidance",
		})

		const result = await getLocalAgentsRules(cwd, {})

		expect(result).toContain("## AGENTS.md")
		expect(result).toContain("root guidance")
		expect(result).not.toContain("api guidance")
	})

	it("returns undefined when the workspace has no top-level agents.md", async () => {
		const cwd = await createWorkspace({ "packages/api/AGENTS.md": "api guidance" })

		expect(await getLocalAgentsRules(cwd, {})).toBeUndefined()
	})

	it("returns undefined when the top-level agents.md is toggled off", async () => {
		const cwd = await createWorkspace({ "AGENTS.md": "root guidance" })
		const toggles = { [path.resolve(cwd, "AGENTS.md")]: false }

		expect(await getLocalAgentsRules(cwd, toggles)).toBeUndefined()
	})
})
