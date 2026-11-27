import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect } from "@playwright/test"

/** The call as a GLM gateway can leave it: markup in the text, not a native tool call. */
const GLM_COMPLETION =
    "<tool_call>attempt_completion<arg_key>result</arg_key><arg_value>E2E_GLM_MARKUP_DONE</arg_value></tool_call>"

/** Serve the mock OpenAI profile under a GLM model id so the ZAI dialect is active. */
async function configureGlmProfile(dlineDir: string): Promise<void> {
    const profilesPath = path.join(dlineDir, "data", "settings", "api_profiles.json")
    const profiles = JSON.parse(await readFile(profilesPath, "utf8")) as Array<{ name: string; modelId?: string }>
    const profile = profiles.find((candidate) => candidate.name === E2E_PROFILE_NAMES.mockOpenAi)
    if (!profile) throw new Error(`Missing E2E profile: ${E2E_PROFILE_NAMES.mockOpenAi}`)
    profile.modelId = "glm-5.3-flash"
    await writeFile(profilesPath, `${JSON.stringify(profiles, null, 2)}\n`, "utf8")

    const settingsPath = path.join(dlineDir, "data", "settings", "settings.json")
    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>
    settings.actModeProfile = E2E_PROFILE_NAMES.mockOpenAi
    settings.planModeProfile = E2E_PROFILE_NAMES.mockOpenAi
    settings.clineWebToolsEnabled = false
    settings.useAutoCondense = false
    await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8")
}

e2e(
    "a GLM call written as text runs its tool and never reaches the chat as markup",
    async ({ helper, sidebar, server, dlineDir, userDataDir }) => {
        await configureGlmProfile(dlineDir)
        await helper.signin(sidebar)
        server.resetOpenAiMock()
        server.enqueueOpenAiResponses({ type: "message", text: GLM_COMPLETION })

        await sidebar.getByTestId("chat-input").fill("Finish the task.")
        await sidebar.getByTestId("send-button").click()

        // The translated call completes the turn, so the result proves it executed.
        await expect(sidebar.getByText("E2E_GLM_MARKUP_DONE", { exact: false })).toBeVisible({ timeout: 60_000 })
        await expect(sidebar.getByText("<tool_call>", { exact: false })).toHaveCount(0)
        await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
    },
)
