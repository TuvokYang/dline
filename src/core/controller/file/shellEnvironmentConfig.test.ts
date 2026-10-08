import assert from "node:assert/strict"
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { load as parseYaml } from "js-yaml"
import { afterEach, beforeEach, describe, it, vi } from "vitest"
import { HostProvider } from "@/hosts/host-provider"
import { ShellEnvironmentVariable, UpdateShellEnvironmentProfileRequest } from "@/shared/proto/dline/file"
import { resolveTerminalProfileId } from "@/utils/shell"
import {
	getShellEnvironmentProfile,
	previewShellEnvironmentProfile,
	updateShellEnvironmentProfile,
} from "./shellEnvironmentConfig"

let workspace: string

beforeEach(async () => {
	workspace = await mkdtemp(path.join(os.tmpdir(), "dline-shell-config-service-"))
	vi.spyOn(HostProvider.workspace, "getWorkspacePaths").mockResolvedValue({ paths: [workspace] })
})

afterEach(async () => {
	vi.restoreAllMocks()
	await rm(workspace, { recursive: true, force: true })
})

function createUpdate(overrides: Partial<UpdateShellEnvironmentProfileRequest> = {}): UpdateShellEnvironmentProfileRequest {
	return UpdateShellEnvironmentProfileRequest.create({
		workspacePath: workspace,
		profile: "default",
		environment: [
			ShellEnvironmentVariable.create({ name: "DLINE_PROFILE", value: "configured" }),
			ShellEnvironmentVariable.create({ name: "REMOVE_FROM_ENV" }),
		],
		startupScripts: ["${workspaceFolder}\\.agents\\startup.ps1", "C:\\BuildTools\\vcvars64.bat"],
		preCommands: ["conda activate dline"],
		postCommand: "Write-Output complete",
		expectedSourceContent: "",
		confirmed: false,
		...overrides,
	})
}

describe("shell environment configuration service", () => {
	it("previews a new profile without writing and requires explicit confirmation", async () => {
		const configPath = path.join(workspace, ".agents", "bashrc.yml")
		const request = createUpdate()

		const preview = await previewShellEnvironmentProfile(request)

		assert.equal(preview.currentContent, "")
		assert.equal(preview.changed, true)
		assert.match(preview.proposedContent, /startupScripts:/)
		assert.match(preview.proposedContent, /preCommands:/)
		assert.match(preview.proposedContent, /postCommand:/)
		await assert.rejects(access(configPath), /ENOENT/)
		await assert.rejects(updateShellEnvironmentProfile(request), /previewed and confirmed/)
		await assert.rejects(access(configPath), /ENOENT/)

		const saved = await updateShellEnvironmentProfile({ ...request, confirmed: true })
		assert.equal(saved.exists, true)
		assert.equal(saved.profile, resolveTerminalProfileId("default"))
		assert.equal(saved.environment.find((entry) => entry.name === "REMOVE_FROM_ENV")?.value, undefined)
		assert.deepEqual(saved.startupScripts, request.startupScripts)
		assert.deepEqual(saved.preCommands, request.preCommands)
		assert.equal(saved.postCommand, request.postCommand)
		assert.equal(await readFile(configPath, "utf8"), saved.sourceContent)
		if (process.platform === "win32") {
			assert.match(saved.sourceContent, /^ {6}powershell:/m)
		}

		const resaved = await updateShellEnvironmentProfile({
			...request,
			profile: saved.profile,
			expectedSourceContent: saved.sourceContent,
			confirmed: true,
		})
		assert.equal(resaved.profile, saved.profile)
		assert.equal(resaved.sourceContent, saved.sourceContent)
	})

	it("updates only the selected platform profile and can replace an existing file atomically", async () => {
		const configPath = path.join(workspace, ".agents", "bashrc.yml")
		const otherPlatform = process.platform === "linux" ? "darwin" : "linux"
		await mkdir(path.dirname(configPath), { recursive: true })
		const original = `version: 1
environment:
  SHARED_VALUE: preserved
platforms:
  ${otherPlatform}:
    profiles:
      bash:
        preCommands:
          - echo linux
  ${process.platform}:
    profiles:
      default:
        preCommands:
          - Write-Output old
`
		await writeFile(configPath, original, "utf8")
		const request = createUpdate({ expectedSourceContent: original })
		const loadedLegacyDefault = await getShellEnvironmentProfile({ workspacePath: workspace, profile: "default" })
		assert.equal(loadedLegacyDefault.profile, resolveTerminalProfileId("default"))
		assert.deepEqual(loadedLegacyDefault.preCommands, ["Write-Output old"])

		const preview = await previewShellEnvironmentProfile(request)
		assert.equal(await readFile(configPath, "utf8"), original)

		const saved = await updateShellEnvironmentProfile({ ...request, confirmed: true })
		const document = parseYaml(saved.sourceContent) as {
			environment: Record<string, string>
			platforms: Record<string, { profiles: Record<string, { preCommands: string[] }> }>
		}
		assert.equal(document.environment.SHARED_VALUE, "preserved")
		assert.deepEqual(document.platforms[otherPlatform].profiles.bash.preCommands, ["echo linux"])
		assert.deepEqual(document.platforms[process.platform].profiles[resolveTerminalProfileId("default")].preCommands, [
			"conda activate dline",
		])
		assert.equal(saved.sourceContent, preview.proposedContent)
	})

	it("rejects stale updates instead of overwriting an external edit", async () => {
		const configPath = path.join(workspace, ".agents", "bashrc.yml")
		await mkdir(path.dirname(configPath), { recursive: true })
		const original = "version: 1\n"
		const external = "version: 1\nenvironment:\n  EXTERNAL_EDIT: preserved\n"
		await writeFile(configPath, original, "utf8")
		const request = createUpdate({ expectedSourceContent: original, confirmed: true })
		await writeFile(configPath, external, "utf8")

		await assert.rejects(updateShellEnvironmentProfile(request), /changed on disk/)
		assert.equal(await readFile(configPath, "utf8"), external)
	})

	it("rejects closed workspaces and profile ids not supplied by availableTerminalProfiles", async () => {
		await assert.rejects(
			getShellEnvironmentProfile({ workspacePath: path.join(workspace, "closed"), profile: "default" }),
			/Workspace is not open/,
		)
		await assert.rejects(
			getShellEnvironmentProfile({ workspacePath: workspace, profile: "invented-profile-id" }),
			/Unknown terminal profile/,
		)
	})
})
