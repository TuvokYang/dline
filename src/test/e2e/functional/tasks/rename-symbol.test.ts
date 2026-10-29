import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { RENAME_PROJECT, readRenameProjectSources, seedRenameProject, waitForTypeScriptService } from "@e2e/utils/rename-project"
import { setWorkAutoApproveAction } from "@e2e/utils/work/session"
import { openWorkspaceFile } from "@e2e/utils/workbench"
import { expect } from "@playwright/test"

const { oldName, newName } = RENAME_PROJECT

e2e(
    "Tools - rename edits every importer when the declaring file is not open in an editor",
    async ({ helper, page, server, sidebar, userDataDir, workspaceDir }) => {
        e2e.setTimeout(180_000)
        await seedRenameProject(workspaceDir)
        await helper.signin(sidebar)
        await setWorkAutoApproveAction(sidebar, "Edit project files", true)
        // Only an importer is open: it starts the TypeScript service, while the declaring file
        // the rename targets has no loaded text model, the state VS Code mishandled.
        await openWorkspaceFile(page, RENAME_PROJECT.importerPaths[0])
        await waitForTypeScriptService(page)

        server.resetOpenAiMock()
        server.enqueueOpenAiResponses(
            {
                type: "tool",
                id: "call_rename_closed_declaration",
                name: "rename",
                arguments: {
                    file_path: RENAME_PROJECT.definitionPath,
                    line: RENAME_PROJECT.definitionLine,
                    character: RENAME_PROJECT.definitionCharacter,
                    new_name: newName,
                },
            },
            {
                type: "tool",
                id: "call_rename_closed_declaration_completion",
                name: "attempt_completion",
                arguments: { result: "E2E_RENAME_CLOSED_DECLARATION_OK" },
                expectedToolResults: [{ callId: "call_rename_closed_declaration", contentIncludes: newName }],
            },
        )

        const input = sidebar.getByTestId("chat-input")
        await input.fill(`Rename ${oldName} to ${newName}.`)
        await sidebar.getByTestId("send-button").click()
        await expect(sidebar.getByText("E2E_RENAME_CLOSED_DECLARATION_OK", { exact: false }).last()).toBeVisible({
            timeout: 60_000,
        })

        const sources = await readRenameProjectSources(workspaceDir)
        expect(sources.map((source) => source.includes(oldName))).toEqual([false, false, false])
        expect(sources.map((source) => source.includes(newName))).toEqual([true, true, true])
        const continuation = server.getMockConsumptions("openai-compatible-chat")[1]
        expect(continuation.contractError).toBeUndefined()
        await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
    },
)
