import { readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { type ClineApiServerMock, type MockExternalUrlVisit } from "@e2e/fixtures/server"
import { expectComposerText } from "@e2e/utils/composer"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame } from "@playwright/test"
import type { ElectronApplication } from "playwright"

const profilesPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "api_profiles.json")
const settingsPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "settings.json")

async function configureNoProfile(dlineDir: string): Promise<void> {
    await writeFile(profilesPath(dlineDir), "[]\n", "utf8")
    const settings = JSON.parse(await readFile(settingsPath(dlineDir), "utf8")) as Record<string, unknown>
    delete settings.actModeProfileId
    delete settings.actModeProfile
    delete settings.planModeProfileId
    delete settings.planModeProfile
    await writeFile(settingsPath(dlineDir), `${JSON.stringify(settings, null, 2)}\n`, "utf8")
}

async function openSidebar(app: ElectronApplication, helper: E2ETestHelper): Promise<Frame> {
    const page = await app.firstWindow()
    await E2ETestHelper.openClineSidebar(page)
    const sidebar = await helper.getSidebar(page)
    await E2ETestHelper.dismissWhatsNewModal(sidebar)
    await helper.signin(sidebar)
    return sidebar
}

async function waitForSingleExternalVisit(server: ClineApiServerMock): Promise<MockExternalUrlVisit> {
    await expect.poll(() => server.getExternalUrlVisits().length, { timeout: 30_000 }).toBe(1)
    return server.getExternalUrlVisits()[0]
}

async function submit(sidebar: Frame, text: string): Promise<void> {
    const input = sidebar.getByTestId("chat-input")
    await expect(input).toBeEnabled()
    await input.fill(text)
    await input.press("Enter")
}

/** The preview's confirm action; nothing leaves the editor before it is clicked. */
function openIssueButton(sidebar: Frame) {
    return sidebar.locator('vscode-button[aria-label="Open GitHub Issue"]')
}

async function confirmReport(sidebar: Frame, server: ClineApiServerMock): Promise<void> {
    const confirm = openIssueButton(sidebar)
    await expect(confirm).toBeVisible({ timeout: 60_000 })
    expect(server.getExternalUrlVisits()).toEqual([])
    await confirm.click()
}

e2e(
    "Report bug - no Profile opens the local editable issue without a Provider request",
    async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
        e2e.setTimeout(180_000)
        await configureNoProfile(dlineDir)
        server.resetOpenAiMock()
        const details = "E2E_REPORT_BUG_NO_PROFILE_DETAILS"

        const app = await openVSCode(workspaceDir)
        try {
            const sidebar = await openSidebar(app, helper)
            await expect(sidebar.getByRole("button", { name: "Select model" })).toContainText("Create profile")

            await submit(sidebar, `/cmd:reportbug ${details}`)
            await confirmReport(sidebar, server)

            const visit = await waitForSingleExternalVisit(server)
            expect(visit.path).toBe("/.test/external-url")
            expect(visit.query).toMatchObject({
                template: "bug_report.yml",
                title: "Dline bug report",
                "what-happened": details,
                "provider-model": "unavailable / unavailable",
            })
            expect(visit.query["additional-context"]).toBe(
                "Opened by Dline's local report fallback because no usable Provider request was available. Images and files selected in Dline are not uploaded; add them manually in this GitHub form.",
            )
            expect(server.getMockConsumptions()).toEqual([])
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await app.close()
        }
    },
)

e2e(
    "Report bug - profile failure reports the recent error without retrying the Provider",
    async ({ helper, server, sidebar, userDataDir }) => {
        e2e.setTimeout(180_000)
        const failureMarker = "E2E_REPORT_BUG_PROFILE_FAILURE"
        const details = "E2E_REPORT_BUG_AFTER_PROFILE_FAILURE"
        server.resetOpenAiMock()
        server.enqueueOpenAiResponses({
            type: "error",
            status: 401,
            code: "invalid_api_key",
            message: failureMarker,
        })
        await helper.signin(sidebar)

        await submit(sidebar, "Trigger a permanent Profile failure")
        await expect(sidebar.getByText(failureMarker, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
        await expect(sidebar.locator('vscode-button[aria-label="Retry"]')).toHaveCount(0)
        expect(server.getRequestCount("openai-compatible-chat")).toBe(1)

        await submit(sidebar, `/cmd:reportbug ${details}`)
        await confirmReport(sidebar, server)

        const visit = await waitForSingleExternalVisit(server)
        expect(visit.query["what-happened"]).toBe(details)
        expect(visit.query.logs).toContain(failureMarker)
        expect(server.getRequestCount("openai-compatible-chat")).toBe(1)
        // The ordinary failure asked for no issue: the only report is the one /reportbug opened.
        await expect(sidebar.getByTestId("report-bug-preview")).toHaveCount(1)
        await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir, [new RegExp(failureMarker), /invalid_api_key/])
    },
)

e2e(
    "Report bug - a /reportbug that fails to send shows the error and opens an issue only when asked again",
    async ({ helper, server, sidebar, userDataDir }) => {
        e2e.setTimeout(180_000)
        // The details must not contain the marker, or the echoed command would satisfy the wait for the failure.
        const failureMarker = "E2E_PROVIDER_REJECTED_REPORT_SEND"
        const details = "E2E_REPORT_BUG_DETAILS_AFTER_SEND"
        server.resetOpenAiMock()
        server.enqueueOpenAiResponses({
            type: "error",
            status: 401,
            code: "invalid_api_key",
            message: failureMarker,
        })
        await helper.signin(sidebar)

        await submit(sidebar, `/cmd:reportbug ${details}`)
        await expect(sidebar.getByText(failureMarker, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
        expect(server.getRequestCount("openai-compatible-chat")).toBe(1)

        // Asking again while the failure stands opens the local report without another request.
        await submit(sidebar, `/cmd:reportbug ${details}`)
        await confirmReport(sidebar, server)

        const visit = await waitForSingleExternalVisit(server)
        expect(visit.query).toMatchObject({ template: "bug_report.yml", title: "Dline bug report", "what-happened": details })
        expect(visit.query.logs).toContain(failureMarker)
        expect(server.getRequestCount("openai-compatible-chat")).toBe(1)
        // The failed send itself asked for no issue: the only report is the one asked for again.
        await expect(sidebar.getByTestId("report-bug-preview")).toHaveCount(1)
        await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir, [new RegExp(failureMarker), /invalid_api_key/])
    },
)

e2e(
    "Report bug - the real /cmd menu command keeps authority across follow-up turns",
    async ({ helper, server, sidebar, userDataDir }) => {
        e2e.setTimeout(180_000)
        const details = "E2E_REPORT_BUG_MENU_DETAILS"
        const followup = "E2E_REPORT_BUG_FOLLOWUP_DETAILS"
        const supplement = "E2E_REPORT_BUG_USER_SUPPLEMENT"
        server.resetOpenAiMock()
        server.enqueueOpenAiResponses(
            {
                type: "tool",
                id: "call_report_bug_question",
                name: "ask_followup_question",
                arguments: { question: "E2E_REPORT_BUG_NEEDS_DETAILS", options: [followup] },
                expectedRequestIncludes: [details, "ask focused follow-up questions", "pending report intent remains authorized"],
            },
            {
                type: "tool",
                id: "call_report_bug",
                name: "report_bug",
                expectedToolResults: [{ callId: "call_report_bug_question", contentIncludes: followup }],
                expectedRequestExcludes: ["explicit_instruction_missing"],
                arguments: {
                    title: "E2E generated bug title",
                    what_happened: "E2E generated description",
                    steps_to_reproduce: "E2E generated steps",
                    api_request_output: "E2E generated request output",
                    additional_context: "E2E AI context",
                },
            },
            {
                type: "tool",
                id: "call_report_bug_done",
                name: "attempt_completion",
                arguments: { result: "E2E_REPORT_BUG_DONE" },
                expectedRequestIncludes: ["The editable GitHub issue form was opened"],
            },
        )
        await helper.signin(sidebar)

        const input = sidebar.getByTestId("chat-input")
        await expect(input).toBeEnabled()
        await input.fill("/rep")
        const menu = sidebar.getByTestId("slash-commands-menu")
        await expect(menu).toBeVisible()
        await menu.getByText("reportbug", { exact: true }).click()
        await expectComposerText(input, "/cmd:reportbug ")
        await input.press("End")
        await input.pressSequentially(details, { delay: 10 })
        await expectComposerText(input, `/cmd:reportbug ${details}`)
        await input.press("Enter")
        await expect(sidebar.getByText("E2E_REPORT_BUG_NEEDS_DETAILS", { exact: true })).toBeVisible({ timeout: 60_000 })
        const followupOption = sidebar.getByRole("button", { name: followup, exact: true })
        await expect(followupOption).toBeEnabled()
        await followupOption.click()

        const reportButton = openIssueButton(sidebar)
        await expect(reportButton).toBeVisible({ timeout: 60_000 })
        expect(server.getExternalUrlVisits()).toEqual([])

        await input.fill(supplement)
        await reportButton.click()

        const visit = await waitForSingleExternalVisit(server)
        expect(visit.query).toMatchObject({
            template: "bug_report.yml",
            title: "E2E generated bug title",
            "what-happened": "E2E generated description",
            steps: "E2E generated steps",
            logs: "E2E generated request output",
            "additional-context": `E2E AI context\n\nUser supplement:\n${supplement}`,
        })
        await expect(sidebar.getByText("E2E_REPORT_BUG_DONE", { exact: false }).last()).toBeVisible({ timeout: 60_000 })

        const consumptions = server.getMockConsumptions("openai-compatible-chat")
        expect(consumptions).toHaveLength(3)
        expect(consumptions.map((consumption) => consumption.toolName)).toEqual([
            "ask_followup_question",
            "report_bug",
            "attempt_completion",
        ])
        expect(consumptions.every((consumption) => consumption.contractError === undefined)).toBe(true)
        await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
    },
)
