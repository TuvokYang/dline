import { expect } from "@playwright/test"
import { E2ETestHelper } from "../utils/helpers"
import { RENAME_PROJECT, readRenameProjectSources, seedRenameProject, waitForTypeScriptService } from "../utils/rename-project"
import { setWorkAutoApproveAction } from "../utils/work/session"
import { activeEditorLines, openWorkspaceFile } from "../utils/workbench"
import { demo } from "./utils/demo-fixture"
import { WINDOW_RECORDING } from "./utils/recording-presets"

const { oldName, newName } = RENAME_PROJECT
const TASK_TEXT = `Rename ${oldName} to ${newName} everywhere it is used.`
const COMPLETION_TEXT = `Renamed ${oldName} to ${newName} across 3 files through the language server.`
// The importer stays on screen so the language-server edit is visible as it lands; the
// declaring file is deliberately left closed, as it usually is when an agent renames.
const SHOWN_IMPORTER_PATH = RENAME_PROJECT.importerPaths[1]

demo(
    "R11",
    async ({
        finishRecording,
        focusCamera,
        helper,
        pace,
        page,
        registerRecording,
        server,
        sidebar,
        userDataDir,
        workspaceDir,
    }) => {
        demo.setTimeout(180_000)
        await seedRenameProject(workspaceDir)
        await helper.signin(sidebar)
        await setWorkAutoApproveAction(sidebar, "Edit project files", true)
        await openWorkspaceFile(page, SHOWN_IMPORTER_PATH)
        await waitForTypeScriptService(page)

        server.resetOpenAiMock()
        server.enqueueOpenAiResponses(
            {
                type: "tool",
                id: "call_r11_rename",
                name: "rename",
                arguments: {
                    file_path: RENAME_PROJECT.definitionPath,
                    line: RENAME_PROJECT.definitionLine,
                    character: RENAME_PROJECT.definitionCharacter,
                    new_name: newName,
                },
                expectedRequestIncludes: [TASK_TEXT],
            },
            {
                type: "tool",
                id: "call_r11_complete",
                name: "attempt_completion",
                arguments: { result: COMPLETION_TEXT },
                expectedToolResults: [{ callId: "call_r11_rename", contentIncludes: newName }],
            },
        )

        const input = sidebar.getByTestId("chat-input")
        const editorLines = activeEditorLines(page)
        await input.hover()
        await input.fill(TASK_TEXT)
        await pace(500)
        await registerRecording("r11-lsp-rename", WINDOW_RECORDING)
        const send = sidebar.getByTestId("send-button")
        await focusCamera([editorLines, input, send])
        await pace(1_400)
        await send.click()

        // The open importer updates in place once the language server's workspace edit is applied.
        await expect(editorLines).toContainText(newName, { timeout: 60_000 })
        await expect(editorLines).not.toContainText(oldName)
        const renameRow = sidebar.getByText(new RegExp(`Rename:\\s*${oldName}\\s*->\\s*${newName}`)).last()
        await expect(renameRow).toBeVisible({ timeout: 30_000 })
        await focusCamera([renameRow, editorLines])
        await pace(2_200)

        const completion = sidebar.getByText(COMPLETION_TEXT, { exact: false }).last()
        await expect(completion).toBeVisible({ timeout: 60_000 })
        await focusCamera([renameRow, completion])
        await pace(1_600)
        await finishRecording()

        const sources = await readRenameProjectSources(workspaceDir)
        expect(sources.every((source) => source.includes(newName) && !source.includes(oldName))).toBe(true)
        const consumptions = server.getMockConsumptions("openai-compatible-chat")
        expect(consumptions.map(({ toolName }) => toolName)).toEqual(["rename", "attempt_completion"])
        expect(consumptions.every(({ contractError }) => contractError === undefined)).toBe(true)
        await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir, [/Error fetching OpenRouter models/])
    },
)
