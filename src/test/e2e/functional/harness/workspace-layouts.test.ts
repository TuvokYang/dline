import { readFile } from "node:fs/promises"
import * as path from "node:path"
import { E2E_WORKSPACE_TYPES, E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame } from "@playwright/test"

async function setAutoApproveAction(sidebar: Frame, label: string, enabled: boolean): Promise<void> {
	await sidebar.getByLabel("Open auto-approve settings").click()
	const checkbox = sidebar.locator("vscode-checkbox").filter({ hasText: label })
	await expect(checkbox).toHaveCount(1)
	const isChecked = () => checkbox.evaluate((element) => Boolean((element as HTMLInputElement).checked))
	if ((await isChecked()) !== enabled) await sidebar.getByText(label, { exact: true }).click()
	await expect.poll(isChecked).toBe(enabled)
	await sidebar.getByLabel("Close auto-approve settings").click()
}

for (const { title, workspaceType } of E2E_WORKSPACE_TYPES) {
	e2e.extend({ workspaceType })(
		`Workspace layout - ${title} resolves parallel file tools and explicit command directories`,
		async ({ helper, multiRootWorkspaceDir, server, sidebar, userDataDir, workspaceDir }) => {
			e2e.setTimeout(180_000)
			await helper.signin(sidebar)
			await setAutoApproveAction(sidebar, "Read project files", true)
			await setAutoApproveAction(sidebar, "Edit project files", true)
			await setAutoApproveAction(sidebar, "Execute safe commands", true)

			const isMultiRoot = workspaceType === "multi"
			const multiRootParent = path.dirname(multiRootWorkspaceDir)
			const primaryRoot = isMultiRoot ? path.join(multiRootParent, "workspace") : workspaceDir
			const secondaryRoot = isMultiRoot ? path.join(multiRootParent, "workspace_2") : undefined
			const primaryToolPath = isMultiRoot ? "@workspace:e2e-layout-primary.txt" : "e2e-layout-primary.txt"
			const commandWorkdirectory = isMultiRoot ? "@workspace_2:." : "."
			const expectedCommandDirectory = isMultiRoot ? "workspace_2" : "workspace"

			const tools = [
				{
					id: "call_layout_read_primary",
					name: "read_file",
					arguments: { path: isMultiRoot ? "@workspace:README.md" : "README.md" },
				},
				{
					id: "call_layout_write_primary",
					name: "write_to_file",
					arguments: { path: primaryToolPath, content: `${title} primary write\n` },
				},
				{
					id: "call_layout_command",
					name: "execute_command",
					arguments: {
						command: `node -e "console.log('E2E_LAYOUT_CWD='+require('path').basename(process.cwd()))"`,
						workdirectory: commandWorkdirectory,
						requires_approval: false,
						synchronous: true,
						timeout: 60,
					},
				},
			]
			if (isMultiRoot) {
				tools.splice(
					1,
					0,
					{
						id: "call_layout_read_secondary",
						name: "read_file",
						arguments: { path: "@workspace_2:README.md" },
					},
					{
						id: "call_layout_write_secondary",
						name: "write_to_file",
						arguments: { path: "@workspace_2:e2e-layout-secondary.txt", content: `${title} secondary write\n` },
					},
				)
			}

			server.resetOpenAiMock()
			server.enqueueOpenAiResponses(
				{ type: "tools", tools },
				{
					type: "tool",
					id: "call_layout_completion",
					name: "attempt_completion",
					arguments: { result: `E2E_${workspaceType.toUpperCase()}_WORKSPACE_LAYOUT_OK` },
					expectedToolResultCount: tools.length,
					expectedToolResults: [
						{ callId: "call_layout_read_primary", contentIncludes: "# Test Workspace" },
						{ callId: "call_layout_write_primary", contentIncludes: "successfully saved" },
						{
							callId: "call_layout_command",
							contentIncludes: [
								"Command executed successfully (exit code 0).",
								`E2E_LAYOUT_CWD=${expectedCommandDirectory}`,
							],
						},
						...(isMultiRoot
							? [
									{ callId: "call_layout_read_secondary", contentIncludes: "# Test Workspace 2" },
									{ callId: "call_layout_write_secondary", contentIncludes: "successfully saved" },
								]
							: []),
					],
				},
			)

			const input = sidebar.getByTestId("chat-input")
			await input.fill(`Exercise the ${title} workspace layout.`)
			await sidebar.getByTestId("send-button").click()
			await expect(
				sidebar.getByText(`E2E_${workspaceType.toUpperCase()}_WORKSPACE_LAYOUT_OK`, { exact: false }).last(),
			).toBeVisible({ timeout: 90_000 })

			expect((await readFile(path.join(primaryRoot, "e2e-layout-primary.txt"), "utf8")).replaceAll("\r\n", "\n")).toBe(
				`${title} primary write\n`,
			)
			if (secondaryRoot) {
				expect(
					(await readFile(path.join(secondaryRoot, "e2e-layout-secondary.txt"), "utf8")).replaceAll("\r\n", "\n"),
				).toBe(`${title} secondary write\n`)
			}

			const initial = server.getMockConsumptions("openai-compatible-chat")[0]
			expect(initial.contractError).toBeUndefined()

			const continuation = server.getMockConsumptions("openai-compatible-chat")[1]
			expect(continuation.contractError).toBeUndefined()
			expect(continuation.requestToolResults).toHaveLength(tools.length)
			for (const tool of tools) {
				expect(continuation.requestToolResults.filter((result) => result.callId === tool.id)).toHaveLength(1)
			}
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		},
	)
}
