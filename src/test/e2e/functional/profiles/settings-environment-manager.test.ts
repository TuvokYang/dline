import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect } from "@playwright/test"

e2e.use({ mockConda: true })

e2e(
	"Python Env Manager - selects a live Conda environment and automatically persists it as a pre-command",
	async ({ helper, sidebar, userDataDir, workspaceDir }) => {
		e2e.setTimeout(120_000)
		await helper.signin(sidebar)

		await sidebar.getByRole("button", { name: "Show Dline Rules & Workflows", exact: true }).first().click()
		await sidebar.getByRole("button", { name: "Environments", exact: true }).click()
		const terminalProfile = sidebar.getByLabel("Terminal Profile")
		await expect(terminalProfile).toHaveValue("default")
		await expect(terminalProfile.locator('option[value="default"]')).toHaveText("Default")
		await sidebar.getByRole("tab", { name: "Commands" }).click()
		await sidebar.getByLabel("Python Env Manager").selectOption("conda")
		await expect(sidebar.getByRole("button", { name: "Refresh Conda environments" })).toHaveCount(0)
		await expect(sidebar.getByRole("button", { name: "Review changes" })).toHaveCount(0)
		await expect(sidebar.getByRole("button", { name: "Confirm Save" })).toHaveCount(0)
		await expect(sidebar.getByRole("button", { name: "Open config" })).toHaveCount(0)
		await expect(sidebar.getByRole("button", { name: "Reinitialize" })).toHaveCount(0)

		const condaEnvironment = sidebar.getByLabel("Conda environment", { exact: true })
		await expect(condaEnvironment).toBeEnabled()
		await expect(condaEnvironment.locator("option")).toHaveText(["Select environment", "base", "dline"])
		await expect(sidebar.getByRole("textbox", { name: "Pre command 1" })).toHaveValue("conda activate base")
		await condaEnvironment.selectOption("dline")
		await expect(sidebar.getByRole("textbox", { name: "Pre command 1" })).toHaveValue("conda activate dline")

		const configPath = path.join(workspaceDir, ".agents", "bashrc.yml")
		const concreteDefaultProfile =
			process.platform === "win32" ? "powershell" : process.platform === "darwin" ? "zsh" : "bash"
		await expect
			.poll(async () => await readFile(configPath, "utf8").catch(() => ""))
			.toContain(`      ${concreteDefaultProfile}:`)
		await expect.poll(async () => await readFile(configPath, "utf8").catch(() => "")).toContain("conda activate dline")

		const externallyEditedConfig = (await readFile(configPath, "utf8")).replace("conda activate dline", "conda activate base")
		await writeFile(configPath, externallyEditedConfig, "utf8")
		await expect(condaEnvironment).toHaveValue("base", { timeout: 5000 })
		await expect(sidebar.getByRole("textbox", { name: "Pre command 1" })).toHaveValue("conda activate base")
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"Python Env Manager - switches from Conda to venv and automatically removes the managed pre-command",
	async ({ helper, sidebar, userDataDir, workspaceDir }) => {
		e2e.setTimeout(120_000)
		await helper.signin(sidebar)

		await sidebar.getByRole("button", { name: "Show Dline Rules & Workflows", exact: true }).first().click()
		await sidebar.getByRole("button", { name: "Environments", exact: true }).click()
		await sidebar.getByRole("tab", { name: "Commands" }).click()
		await sidebar.getByLabel("Python Env Manager").selectOption("conda")
		const condaEnvironment = sidebar.getByLabel("Conda environment", { exact: true })
		await expect(condaEnvironment.locator("option")).toHaveText(["Select environment", "base", "dline"])
		await condaEnvironment.selectOption("base")
		await expect(sidebar.getByRole("textbox", { name: "Pre command 1" })).toHaveValue("conda activate base")

		await sidebar.getByLabel("Python Env Manager").selectOption("venv")
		const venvPath = sidebar.getByLabel("venv path")
		const configuredVenvPath = process.platform === "win32" ? "${workspaceFolder}\\.venv" : "${workspaceFolder}/.venv"
		const activationCommand =
			process.platform === "win32"
				? '& "${workspaceFolder}\\.venv\\Scripts\\Activate.ps1"'
				: ". '${workspaceFolder}/.venv/bin/activate'"
		await venvPath.fill(configuredVenvPath)
		await expect(sidebar.getByRole("textbox", { name: "Pre command 1" })).toHaveValue(activationCommand)
		await expect
			.poll(async () => await readFile(path.join(workspaceDir, ".agents", "bashrc.yml"), "utf8").catch(() => ""))
			.toContain(activationCommand)

		await sidebar.getByLabel("Python Env Manager").selectOption("none")
		await expect(sidebar.getByRole("textbox", { name: "Pre command 1" })).toHaveCount(0)
		await expect
			.poll(async () => await readFile(path.join(workspaceDir, ".agents", "bashrc.yml"), "utf8").catch(() => ""))
			.not.toContain("activate")
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)
