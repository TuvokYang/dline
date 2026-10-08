import { createSessionFixture } from "@core/task/session/__fixtures__/active-task-session"
import { CreateSkillRequest, DeleteSkillRequest, RuleFileRequest } from "@shared/proto/dline/file"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { HostProvider } from "@/hosts/host-provider"
import { createRuleFile } from "../createRuleFile"
import { createSkillFile } from "../createSkillFile"
import { deleteRuleFile } from "../deleteRuleFile"
import { deleteSkillFile } from "../deleteSkillFile"

const mocks = vi.hoisted(() => ({
	createRuleFileImpl: vi.fn(),
	deleteRuleFileImpl: vi.fn(),
	ensureAgentSkillsDirectoryExists: vi.fn(),
	openFile: vi.fn().mockResolvedValue(undefined),
	refreshClineRulesToggles: vi.fn().mockResolvedValue(undefined),
	refreshWorkflowToggles: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("@core/context/instructions/user-instructions/agent-rules", () => ({
	refreshClineRulesToggles: mocks.refreshClineRulesToggles,
}))
vi.mock("@core/context/instructions/user-instructions/rule-helpers", () => ({
	createRuleFile: mocks.createRuleFileImpl,
	deleteRuleFile: mocks.deleteRuleFileImpl,
}))
vi.mock("@core/storage/disk", () => ({
	ensureAgentSkillsDirectoryExists: mocks.ensureAgentSkillsDirectoryExists,
}))
vi.mock("@/core/context/instructions/user-instructions/workflows", () => ({
	refreshWorkflowToggles: mocks.refreshWorkflowToggles,
}))
vi.mock("@/utils/path", () => ({
	getCwd: vi.fn(async (fallback: string) => fallback),
	getDesktopDir: vi.fn(() => "C:/workspace"),
}))
vi.mock("../openFile", () => ({
	openFile: mocks.openFile,
}))

describe("Prompt input file freshness mutations", () => {
	let tempDirectory: string
	let skillsDirectory: string

	beforeEach(async () => {
		tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "prompt-input-file-mutation-"))
		skillsDirectory = path.join(tempDirectory, ".agents", "skills")
		await fs.mkdir(skillsDirectory, { recursive: true })
		mocks.ensureAgentSkillsDirectoryExists.mockResolvedValue(skillsDirectory)
		mocks.createRuleFileImpl.mockReset()
		mocks.deleteRuleFileImpl.mockReset()
		mocks.openFile.mockClear()
		mocks.refreshClineRulesToggles.mockClear()
		mocks.refreshWorkflowToggles.mockClear()
		vi.spyOn(HostProvider, "workspace", "get").mockReturnValue({
			getWorkspacePaths: vi.fn().mockResolvedValue({ paths: [tempDirectory] }),
		} as never)
		vi.spyOn(HostProvider, "window", "get").mockReturnValue({
			showMessage: vi.fn().mockResolvedValue(undefined),
		} as never)
	})

	afterEach(async () => {
		vi.restoreAllMocks()
		await fs.rm(tempDirectory, { recursive: true, force: true })
	})

	function createController() {
		const globalSkillsToggles: Record<string, boolean> = {}
		const localSkillsToggles: Record<string, boolean> = {}
		const flushPromptFreshnessInvalidation = vi.fn().mockResolvedValue(undefined)
		const postStateToWebview = vi.fn().mockResolvedValue(undefined)
		return {
			controller: {
				stateManager: {
					getGlobalSettingsKey: vi.fn().mockReturnValue(globalSkillsToggles),
					// Locally discovered skills read their overrides from the scope
					// chain now, so the fake exposes the scoped reader instead of the
					// retired workspace-state map.
					getScopedCapabilityToggles: vi
						.fn()
						.mockImplementation((scope: string) => (scope === "workspace" ? localSkillsToggles : {})),
					mutateScopedCapabilityToggles: vi.fn().mockResolvedValue(localSkillsToggles),
					setWorkspaceState: vi.fn(),
				},
				task: createSessionFixture({ owners: { prompt: { flush: flushPromptFreshnessInvalidation } } }),
				postStateToWebview,
			} as never,
			flushPromptFreshnessInvalidation,
			postStateToWebview,
		}
	}

	it("flushes active Task freshness after committed Rule, Workflow, and Skill file mutations", async () => {
		const fixture = createController()
		const rulePath = path.join(tempDirectory, "rules", "project.md")
		const workflowPath = path.join(tempDirectory, "workflows", "release.md")
		mocks.createRuleFileImpl
			.mockResolvedValueOnce({ filePath: rulePath, fileExists: false })
			.mockResolvedValueOnce({ filePath: workflowPath, fileExists: false })
		mocks.deleteRuleFileImpl.mockResolvedValue({ success: true })

		await createRuleFile(
			fixture.controller,
			RuleFileRequest.create({ isGlobal: false, filename: "project.md", type: "rule" }),
		)
		await createRuleFile(
			fixture.controller,
			RuleFileRequest.create({ isGlobal: false, filename: "release.md", type: "workflow" }),
		)
		await deleteRuleFile(fixture.controller, RuleFileRequest.create({ isGlobal: false, rulePath, type: "rule" }))

		await createSkillFile(fixture.controller, CreateSkillRequest.create({ skillName: "reviewer", isGlobal: false }))
		const skillPath = path.join(skillsDirectory, "reviewer", "SKILL.md")
		await deleteSkillFile(fixture.controller, DeleteSkillRequest.create({ skillPath, isGlobal: false }))

		expect(fixture.flushPromptFreshnessInvalidation).toHaveBeenCalledTimes(5)
		expect(fixture.flushPromptFreshnessInvalidation).toHaveBeenCalledWith("capability_mutation")
		expect(fixture.postStateToWebview).not.toHaveBeenCalled()
		expect(mocks.refreshClineRulesToggles).toHaveBeenCalledOnce()
		expect(mocks.refreshWorkflowToggles).toHaveBeenCalledOnce()
	})

	it("does not emit freshness when create/delete resolves without a committed mutation", async () => {
		const fixture = createController()
		const existingRulePath = path.join(tempDirectory, "rules", "existing.md")
		mocks.createRuleFileImpl.mockResolvedValue({ filePath: existingRulePath, fileExists: true })
		mocks.deleteRuleFileImpl.mockResolvedValue({ success: false, message: "delete failed" })

		await createRuleFile(
			fixture.controller,
			RuleFileRequest.create({ isGlobal: false, filename: "existing.md", type: "rule" }),
		)
		await expect(
			deleteRuleFile(
				fixture.controller,
				RuleFileRequest.create({ isGlobal: false, rulePath: existingRulePath, type: "rule" }),
			),
		).rejects.toThrow("delete failed")

		await fs.mkdir(path.join(skillsDirectory, "existing"), { recursive: true })
		await createSkillFile(fixture.controller, CreateSkillRequest.create({ skillName: "existing", isGlobal: false }))
		await deleteSkillFile(
			fixture.controller,
			DeleteSkillRequest.create({ skillPath: path.join(skillsDirectory, "missing", "SKILL.md"), isGlobal: false }),
		)

		expect(fixture.flushPromptFreshnessInvalidation).not.toHaveBeenCalled()
	})

	it("does not emit freshness when a Skill file write or delete fails", async () => {
		const fixture = createController()
		const writeError = vi.spyOn(fs, "writeFile").mockRejectedValueOnce(new Error("write failed"))

		await expect(
			createSkillFile(fixture.controller, CreateSkillRequest.create({ skillName: "writer", isGlobal: false })),
		).rejects.toThrow("write failed")
		expect(fixture.flushPromptFreshnessInvalidation).not.toHaveBeenCalled()
		writeError.mockRestore()

		const skillDirectory = path.join(skillsDirectory, "deleter")
		const skillPath = path.join(skillDirectory, "SKILL.md")
		await fs.mkdir(skillDirectory, { recursive: true })
		await fs.writeFile(skillPath, "---\nname: deleter\n---\n", "utf8")
		vi.spyOn(fs, "rm").mockRejectedValueOnce(new Error("delete failed"))

		await expect(
			deleteSkillFile(fixture.controller, DeleteSkillRequest.create({ skillPath, isGlobal: false })),
		).rejects.toThrow("delete failed")
		expect(fixture.flushPromptFreshnessInvalidation).not.toHaveBeenCalled()
	})
})
