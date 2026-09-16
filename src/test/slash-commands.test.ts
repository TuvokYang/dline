import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it, vi } from "vitest"
import "should"
// sinon import removed
import { Controller } from "../core/controller"
import { getAvailableSlashCommands } from "../core/controller/slash/getAvailableSlashCommands"
import { EmptyRequest } from "../shared/proto/dline/common"
import { BASE_SLASH_COMMANDS, VSCODE_ONLY_COMMANDS } from "../shared/slashCommands"
import { createTaskCapabilityToggles, serializeTaskCapabilityToggles } from "../shared/TaskCapabilityToggles"

/**
 * Unit tests for getAvailableSlashCommands RPC endpoint
 * Tests the slash command discovery and filtering functionality
 */
describe("getAvailableSlashCommands", () => {
	const temporaryDirectories: string[] = []
	let mockController: Partial<Controller>
	let mockStateManager: {
		getWorkspaceStateKey: any /* sinon.SinonStub → vitest */
		getScopedCapabilityToggles: any /* sinon.SinonStub → vitest */
		getGlobalSettingsKey: any /* sinon.SinonStub → vitest */
		getGlobalStateKey: any /* sinon.SinonStub → vitest */
		getRemoteConfigSettings: any /* sinon.SinonStub → vitest */
	}

	/**
	 * Serve a legacy workspace-state map through the scope chain reader.
	 *
	 * Locally discovered capabilities now resolve global → workspace → task, so
	 * the fixtures below describe the workspace layer and leave the other two
	 * empty, which is what "no explicit override" looks like.
	 */
	function scopedFromWorkspace(read: (settingsKey: string) => Record<string, boolean> | null | undefined) {
		return (scope: string, settingsKey: string) => (scope === "workspace" ? (read(settingsKey) ?? {}) : {})
	}

	beforeEach(() => {
		mockStateManager = {
			getWorkspaceStateKey: vi.fn(),
			getScopedCapabilityToggles: vi.fn(),
			getGlobalSettingsKey: vi.fn(),
			getGlobalStateKey: vi.fn(),
			getRemoteConfigSettings: vi.fn(),
		}

		// Default stubs return empty/null values
		mockStateManager.getWorkspaceStateKey.mockReturnValue(null)
		mockStateManager.getScopedCapabilityToggles.mockReturnValue({})
		mockStateManager.getGlobalSettingsKey.mockReturnValue(null)
		mockStateManager.getGlobalStateKey.mockReturnValue(null)
		mockStateManager.getRemoteConfigSettings.mockReturnValue(null)

		mockController = {
			stateManager: mockStateManager as any,
		}
	})

	afterEach(async () => {
		vi.restoreAllMocks()
		await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
	})

	describe("Base Slash Commands", () => {
		it("should return VS Code-only slash commands", async () => {
			const response = await getAvailableSlashCommands(mockController as Controller, EmptyRequest.create())

			for (const vscodeCommand of VSCODE_ONLY_COMMANDS) {
				const found = response.commands.find((command) => command.name === vscodeCommand.name)
				;(found === undefined).should.be.false()
				found!.description.should.equal(vscodeCommand.description)
				found!.section.should.equal("default")
				found!.cliCompatible.should.equal(false)
			}
		})

		it("should return all base slash commands", async () => {
			const response = await getAvailableSlashCommands(mockController as Controller, EmptyRequest.create())

			// Should have at least all base commands
			response.commands.length.should.be.greaterThanOrEqual(BASE_SLASH_COMMANDS.length)

			// Verify each base command is present
			for (const baseCmd of BASE_SLASH_COMMANDS) {
				const found = response.commands.find((cmd) => cmd.name === baseCmd.name)
				found?.should.not.be.undefined()
				found?.description.should.equal(baseCmd.description)
				found?.section.should.equal("default")
				found?.cliCompatible.should.equal(baseCmd.cliCompatible ?? false)
			}
		})

		it("should not include the deprecated subagent slash command", async () => {
			const response = await getAvailableSlashCommands(mockController as Controller, EmptyRequest.create())
			const deprecatedCommand = response.commands.find((cmd) => cmd.name === "subagent")
			;(deprecatedCommand === undefined).should.be.true()
		})

		it("should mark base commands with section 'default'", async () => {
			const response = await getAvailableSlashCommands(mockController as Controller, EmptyRequest.create())

			const baseCommandNames = BASE_SLASH_COMMANDS.map((cmd) => cmd.name)
			for (const cmd of response.commands) {
				if (baseCommandNames.includes(cmd.name)) {
					cmd.section.should.equal("default")
				}
			}
		})
	})

	describe("Local Workflow Toggles", () => {
		it("should include enabled local workflows", async () => {
			mockStateManager.getScopedCapabilityToggles.mockImplementation(
				scopedFromWorkspace(() => ({
					"/path/to/my-workflow.md": true,
					"/path/to/another-workflow.md": true,
				})),
			)

			const response = await getAvailableSlashCommands(mockController as Controller, EmptyRequest.create())

			const myWorkflow = response.commands.find((cmd) => cmd.name === "my-workflow")
			myWorkflow?.should.not.be.undefined()
			myWorkflow?.section.should.equal("workflow")
			myWorkflow?.cliCompatible.should.equal(true)

			const anotherWorkflow = response.commands.find((cmd) => cmd.name === "another-workflow")
			anotherWorkflow?.should.not.be.undefined()
		})

		it("should exclude disabled local workflows", async () => {
			mockStateManager.getScopedCapabilityToggles.mockImplementation(
				scopedFromWorkspace(() => ({
					"/path/to/enabled-workflow.md": true,
					"/path/to/disabled-workflow.md": false,
				})),
			)

			const response = await getAvailableSlashCommands(mockController as Controller, EmptyRequest.create())

			const enabled = response.commands.find((cmd) => cmd.name === "enabled-workflow")
			enabled?.should.not.be.undefined()

			const disabled = response.commands.find((cmd) => cmd.name === "disabled-workflow")
			;(disabled === undefined).should.be.true()
		})

		it("should extract filename from full path", async () => {
			mockStateManager.getScopedCapabilityToggles.mockImplementation(
				scopedFromWorkspace(() => ({
					"/Users/test/project/.clinerules/workflows/deep-analysis.md": true,
				})),
			)

			const response = await getAvailableSlashCommands(mockController as Controller, EmptyRequest.create())

			const workflow = response.commands.find((cmd) => cmd.name === "deep-analysis")
			workflow?.should.not.be.undefined()
		})

		it("should handle Windows-style paths", async () => {
			mockStateManager.getScopedCapabilityToggles.mockImplementation(
				scopedFromWorkspace(() => ({
					"C:\\Users\\test\\project\\.clinerules\\workflows\\windows-workflow.md": true,
				})),
			)

			const response = await getAvailableSlashCommands(mockController as Controller, EmptyRequest.create())

			const workflow = response.commands.find((cmd) => cmd.name === "windows-workflow")
			workflow?.should.not.be.undefined()
		})
	})

	describe("Global Workflow Toggles", () => {
		it("should include enabled global workflows", async () => {
			mockStateManager.getGlobalSettingsKey.mockReturnValue({
				"/global/path/global-workflow.md": true,
			})

			const response = await getAvailableSlashCommands(mockController as Controller, EmptyRequest.create())

			const workflow = response.commands.find((cmd) => cmd.name === "global-workflow")
			workflow?.should.not.be.undefined()
			workflow?.section.should.equal("workflow")
		})

		it("should exclude disabled global workflows", async () => {
			mockStateManager.getGlobalSettingsKey.mockReturnValue({
				"/global/path/disabled-global.md": false,
			})

			const response = await getAvailableSlashCommands(mockController as Controller, EmptyRequest.create())

			const workflow = response.commands.find((cmd) => cmd.name === "disabled-global")
			;(workflow === undefined).should.be.true()
		})
	})

	describe("Workflow Deduplication", () => {
		it("should prefer local workflows over global workflows with same name", async () => {
			// Same filename in both local and global
			mockStateManager.getScopedCapabilityToggles.mockImplementation(
				scopedFromWorkspace((settingsKey) =>
					settingsKey === "workspaceWorkflowToggles" ? { "/local/path/shared-workflow.md": true } : null,
				),
			)
			mockStateManager.getGlobalSettingsKey.mockImplementation((key: string) =>
				key === "globalWorkflowToggles" ? { "/global/path/shared-workflow.md": true } : null,
			)

			const response = await getAvailableSlashCommands(mockController as Controller, EmptyRequest.create())

			// Should only appear once
			const matches = response.commands.filter((cmd) => cmd.name === "shared-workflow")
			matches.length.should.equal(1)
			matches[0].section.should.equal("workflow")
		})

		it("should include global workflow if local with same name is disabled", async () => {
			mockStateManager.getScopedCapabilityToggles.mockImplementation(
				scopedFromWorkspace((settingsKey) =>
					settingsKey === "workspaceWorkflowToggles" ? { "/local/path/shared-workflow.md": false } : null,
				),
			)
			mockStateManager.getGlobalSettingsKey.mockImplementation((key: string) =>
				key === "globalWorkflowToggles" ? { "/global/path/shared-workflow.md": true } : null,
			)

			const response = await getAvailableSlashCommands(mockController as Controller, EmptyRequest.create())

			// Global should appear since local is disabled
			const workflow = response.commands.find((cmd) => cmd.name === "shared-workflow")
			workflow?.should.not.be.undefined()
			workflow?.section.should.equal("workflow")
		})
	})

	describe("Remote Workflows", () => {
		it("uses the active task snapshot instead of the global remote workflow toggle", async () => {
			mockStateManager.getRemoteConfigSettings.mockReturnValue({
				remoteGlobalWorkflows: [{ name: "task-disabled-workflow", alwaysEnabled: false }],
			})
			mockStateManager.getGlobalStateKey.mockReturnValue({
				"task-disabled-workflow": true,
			})
			mockController.task = {
				taskSm: {
					taskCapabilityToggles: serializeTaskCapabilityToggles(
						createTaskCapabilityToggles({
							remoteWorkflowToggles: { "task-disabled-workflow": false },
						}),
					),
				},
			} as Controller["task"]

			const response = await getAvailableSlashCommands(mockController as Controller, EmptyRequest.create())

			const workflow = response.commands.find((cmd) => cmd.name === "task-disabled-workflow")
			;(workflow === undefined).should.be.true()
		})

		it("should include alwaysEnabled remote workflows", async () => {
			mockStateManager.getRemoteConfigSettings.mockReturnValue({
				remoteGlobalWorkflows: [{ name: "always-on-workflow", alwaysEnabled: true }],
			})

			const response = await getAvailableSlashCommands(mockController as Controller, EmptyRequest.create())

			const workflow = response.commands.find((cmd) => cmd.name === "always-on-workflow")
			workflow?.should.not.be.undefined()
			workflow?.section.should.equal("custom")
		})

		it("should include remote workflows enabled by toggle", async () => {
			mockStateManager.getRemoteConfigSettings.mockReturnValue({
				remoteGlobalWorkflows: [{ name: "toggle-workflow", alwaysEnabled: false }],
			})
			mockStateManager.getGlobalStateKey.mockReturnValue({
				"toggle-workflow": true, // not explicitly disabled
			})

			const response = await getAvailableSlashCommands(mockController as Controller, EmptyRequest.create())

			const workflow = response.commands.find((cmd) => cmd.name === "toggle-workflow")
			workflow?.should.not.be.undefined()
		})

		it("should exclude remote workflows explicitly disabled by toggle", async () => {
			mockStateManager.getRemoteConfigSettings.mockReturnValue({
				remoteGlobalWorkflows: [{ name: "disabled-remote", alwaysEnabled: false }],
			})
			mockStateManager.getGlobalStateKey.mockReturnValue({
				"disabled-remote": false,
			})

			const response = await getAvailableSlashCommands(mockController as Controller, EmptyRequest.create())

			const workflow = response.commands.find((cmd) => cmd.name === "disabled-remote")
			;(workflow === undefined).should.be.true()
		})

		it("should include remote workflows by default if not explicitly disabled", async () => {
			mockStateManager.getRemoteConfigSettings.mockReturnValue({
				remoteGlobalWorkflows: [{ name: "default-enabled", alwaysEnabled: false }],
			})
			// No toggle entry for this workflow
			mockStateManager.getGlobalStateKey.mockReturnValue({})

			const response = await getAvailableSlashCommands(mockController as Controller, EmptyRequest.create())

			const workflow = response.commands.find((cmd) => cmd.name === "default-enabled")
			workflow?.should.not.be.undefined()
		})

		it("should hide remote workflow when local workflow has same name", async () => {
			mockStateManager.getScopedCapabilityToggles.mockImplementation(
				scopedFromWorkspace((settingsKey) =>
					settingsKey === "workspaceWorkflowToggles" ? { "/local/path/shared-workflow.md": true } : null,
				),
			)
			mockStateManager.getRemoteConfigSettings.mockReturnValue({
				remoteGlobalWorkflows: [{ name: "shared-workflow", alwaysEnabled: true }],
			})

			const response = await getAvailableSlashCommands(mockController as Controller, EmptyRequest.create())

			const matches = response.commands.filter((cmd) => cmd.name === "shared-workflow")
			matches.length.should.equal(1)
			matches[0].section.should.equal("workflow")
		})
	})

	describe("Local Skill Discovery", () => {
		it("uses discovered skills and frontmatter names without requiring a stored default toggle", async () => {
			const root = await mkdtemp(path.join(tmpdir(), "dline-slash-skill-"))
			temporaryDirectories.push(root)
			const skillDirectory = path.join(root, "folder-name")
			const skillPath = path.join(skillDirectory, "SKILL.md")
			await mkdir(skillDirectory, { recursive: true })
			await writeFile(
				skillPath,
				["---", "name: frontmatter-skill", "description: Discovered skill", "---", "Skill body"].join("\n"),
				"utf8",
			)
			mockStateManager.getWorkspaceStateKey.mockImplementation((key: string) =>
				key === "discoveredSkillsToggles" ? { [skillPath]: true } : null,
			)

			const response = await getAvailableSlashCommands(mockController as Controller, EmptyRequest.create())

			const skill = response.commands.find((command) => command.name === "frontmatter-skill")
			skill?.should.not.be.undefined()
			skill?.section.should.equal("skill")
			skill?.description.should.equal("Skill: frontmatter-skill")
			JSON.stringify(response.commands).includes(skillPath).should.be.false()
			response.commands.some((command) => command.name === "SKILL").should.be.false()
		})
	})

	describe("Skill Deduplication", () => {
		it("should prefer local skills over global and remote skills with same name", async () => {
			mockStateManager.getScopedCapabilityToggles.mockImplementation(
				scopedFromWorkspace((settingsKey) =>
					settingsKey === "workspaceSkillsToggles" ? { "/local/path/shared-skill.md": true } : null,
				),
			)
			mockStateManager.getGlobalSettingsKey.mockImplementation((key: string) =>
				key === "globalSkillsToggles" ? { "/global/path/shared-skill.md": true } : null,
			)
			mockStateManager.getRemoteConfigSettings.mockReturnValue({
				remoteGlobalSkills: [{ name: "shared-skill", alwaysEnabled: true }],
			})

			const response = await getAvailableSlashCommands(mockController as Controller, EmptyRequest.create())

			const matches = response.commands.filter((cmd) => cmd.name === "shared-skill")
			matches.length.should.equal(1)
			matches[0].description.should.equal("Skill: shared-skill")
			matches[0].section.should.equal("skill")
		})
	})

	describe("Edge Cases", () => {
		it("should handle null/undefined state values gracefully", async () => {
			mockStateManager.getScopedCapabilityToggles.mockReturnValue(undefined)
			mockStateManager.getGlobalSettingsKey.mockReturnValue(undefined)
			mockStateManager.getGlobalStateKey.mockReturnValue(null)
			mockStateManager.getRemoteConfigSettings.mockReturnValue(null)

			const response = await getAvailableSlashCommands(mockController as Controller, EmptyRequest.create())

			// Should still return base commands
			response.commands.length.should.be.greaterThanOrEqual(BASE_SLASH_COMMANDS.length)
		})

		it("should handle empty workflow toggle objects", async () => {
			mockStateManager.getScopedCapabilityToggles.mockReturnValue({})
			mockStateManager.getGlobalSettingsKey.mockReturnValue({})
			mockStateManager.getGlobalStateKey.mockReturnValue({})
			mockStateManager.getRemoteConfigSettings.mockReturnValue({
				remoteGlobalWorkflows: [],
			})

			const response = await getAvailableSlashCommands(mockController as Controller, EmptyRequest.create())

			// Should only have built-in VS Code commands
			response.commands.length.should.equal(BASE_SLASH_COMMANDS.length + VSCODE_ONLY_COMMANDS.length)
		})

		it("should handle remote config with no remoteGlobalWorkflows property", async () => {
			mockStateManager.getRemoteConfigSettings.mockReturnValue({})

			const response = await getAvailableSlashCommands(mockController as Controller, EmptyRequest.create())

			// Should not throw, just return base commands
			response.commands.length.should.be.greaterThanOrEqual(BASE_SLASH_COMMANDS.length)
		})
	})
})
