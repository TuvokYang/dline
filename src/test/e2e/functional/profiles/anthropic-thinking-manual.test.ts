import { mkdir, readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
import type { ClineApiServerMock, MockThinkingConfig } from "@e2e/fixtures/server"
import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame, type Locator, type Page, type TestInfo } from "@playwright/test"
import type { ApiProfile } from "@shared/proto/dline/profile"
import type { AnthropicProviderConfig } from "@shared/proto/dline/provider/anthropic"
import type { ReasoningConfig } from "@shared/proto/dline/provider/common"
import type { ProviderModelsConfig } from "@shared/providers/types"
import type { ElectronApplication } from "playwright"

/** Read raw JSON: proto hydration could hide an unwanted persisted default. */
type StoredProfile = Pick<ApiProfile, "id" | "name" | "provider" | "modelId" | "enabled" | "usedFor"> &
    Partial<Pick<ApiProfile, "baseUrl" | "modelInfo">> & {
        anthropic?: Partial<AnthropicProviderConfig>
        webToolsMode?: string
    }

type ThinkingCase = "manual" | "supports-false" | "thinking-false" | "known-effort" | "known-budget"

interface ThinkingHost {
    page: Page
    sidebar: Frame
    restart: () => Promise<void>
}

interface RequestChoice {
    modelId: string
    thinking?: MockThinkingConfig
    display?: string
}

const PROFILE_NAME = E2E_PROFILE_NAMES.mockAnthropic
// Deliberately outside the Claude inheritance families and the mock model listing.
const MANUAL_MODEL = "dline-e2e-anthropic-manual"
const KNOWN_EFFORT = "claude-opus-4-8"
const KNOWN_BUDGET = "dline-e2e-anthropic-catalog-budget"
const MANUAL_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"]
const EFFORT_LABELS = ["None", "Low", "Medium", "High", "Xhigh", "Max"]

const profilesPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "api_profiles.json")
const settingsPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "settings.json")
const catalogPath = (dlineDir: string) => path.join(dlineDir, "providers", "anthropic.json")

async function readProfiles(dlineDir: string): Promise<StoredProfile[]> {
    return JSON.parse(await readFile(profilesPath(dlineDir), "utf8")) as StoredProfile[]
}

async function readProfile(dlineDir: string): Promise<StoredProfile> {
    const profile = (await readProfiles(dlineDir)).find((candidate) => candidate.name === PROFILE_NAME)
    if (!profile) throw new Error("Missing isolated Anthropic mock Profile")
    return profile
}

async function readCatalog(dlineDir: string): Promise<ProviderModelsConfig> {
    return JSON.parse(await readFile(catalogPath(dlineDir), "utf8")) as ProviderModelsConfig
}

/** A known budget declaration lives in the registry, never in a Profile override. */
async function seedCatalog(dlineDir: string): Promise<void> {
    let catalog: ProviderModelsConfig = {
        provider: "anthropic",
        providerName: "Anthropic",
        billingMode: "token",
        models: {},
    }
    try {
        catalog = await readCatalog(dlineDir)
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    catalog.models[KNOWN_BUDGET] = {
        id: KNOWN_BUDGET,
        name: KNOWN_BUDGET,
        userDefined: true,
        capabilities: {
            supportsTools: true,
            contextWindow: 131_072,
            maxTokens: 8192,
            supportsReasoning: true,
            thinking: {
                supported: true,
                mode: "budget",
                minBudget: 1024,
                maxBudget: 4096,
                canDisable: true,
                defaultEnabled: false,
            },
        },
    }
    // seed-initializer refreshes built-ins but preserves this userDefined entry.
    await mkdir(path.dirname(catalogPath(dlineDir)), { recursive: true })
    await writeFile(catalogPath(dlineDir), `${JSON.stringify(catalog, null, 2)}\n`, "utf8")
}

/** The only Profile writes in this file happen before any host can start. */
async function seedProfile(dlineDir: string, thinkingCase: ThinkingCase): Promise<void> {
    const profiles = await readProfiles(dlineDir)
    const profile = profiles.find((candidate) => candidate.name === PROFILE_NAME)
    if (!profile) throw new Error("Missing isolated Anthropic mock Profile")
    if (!profile.baseUrl || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(profile.baseUrl).hostname)) {
        throw new Error("Anthropic thinking E2E requires the isolated loopback mock endpoint")
    }
    // Keep the fixture's stable ID, loopback base URL, enabled/usedFor and fake key.
    // In particular, do not carry its default High/zero-budget reasoning forward.
    delete profile.modelInfo
    profile.modelId =
        thinkingCase === "known-effort" ? KNOWN_EFFORT : thinkingCase === "known-budget" ? KNOWN_BUDGET : MANUAL_MODEL
    profile.webToolsMode = "WEB_TOOLS_MODE_FORCE_OFF"
    profile.anthropic = thinkingCase.startsWith("known-")
        ? { customModelEnabled: false }
        : {
              customModelEnabled: true,
              capabilities: { supportsTools: true, contextWindow: 131_072, maxTokens: 8192 },
          }
    if (thinkingCase === "supports-false") {
        profile.anthropic.capabilities = { ...profile.anthropic.capabilities, supportsReasoning: false }
    }
    if (thinkingCase === "thinking-false") {
        profile.anthropic.capabilities = { ...profile.anthropic.capabilities, thinking: { supported: false } }
    }
    await writeFile(profilesPath(dlineDir), `${JSON.stringify(profiles, null, 2)}\n`, "utf8")
    if (thinkingCase === "known-budget") await seedCatalog(dlineDir)

    const settings = JSON.parse(await readFile(settingsPath(dlineDir), "utf8")) as Record<string, unknown>
    settings.actModeProfile = PROFILE_NAME
    settings.planModeProfile = PROFILE_NAME
    settings.uiLanguage = "en"
    settings.clineWebToolsEnabled = false
    settings.useAutoCondense = false
    settings.enableCheckpointsSetting = false
    await writeFile(settingsPath(dlineDir), `${JSON.stringify(settings, null, 2)}\n`, "utf8")
}

async function attachShot(testInfo: TestInfo, name: string, page: Page): Promise<void> {
    await testInfo.attach(name, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })
}

/** Whitelist evidence rather than serializing a Profile's API key or secrets. */
async function attachProfile(testInfo: TestInfo, name: string, profile: StoredProfile): Promise<void> {
    await testInfo.attach(name, {
        body: Buffer.from(
            JSON.stringify(
                {
                    id: profile.id,
                    name: profile.name,
                    provider: profile.provider,
                    modelId: profile.modelId,
                    enabled: profile.enabled,
                    usedFor: profile.usedFor,
                    webToolsMode: profile.webToolsMode,
                    modelInfo: profile.modelInfo,
                    anthropic: {
                        customModelEnabled: profile.anthropic?.customModelEnabled,
                        capabilities: profile.anthropic?.capabilities,
                        reasoning: profile.anthropic?.reasoning,
                    },
                },
                null,
                2,
            ),
        ),
        contentType: "application/json",
    })
}

// This dependency runs before openVSCode (including its fixture setup). Never
// destructure the base app/page/sidebar fixtures alongside this owned host.
const thinkingE2e = e2e.extend<{ thinkingCase: ThinkingCase; host: ThinkingHost }>({
    thinkingCase: ["manual", { option: true }],
    dlineDir: async ({ dlineDir, thinkingCase }, use) => {
        await seedProfile(dlineDir, thinkingCase)
        await use(dlineDir)
    },
    host: async ({ helper, openVSCode, workspaceDir }, use, testInfo) => {
        let app: ElectronApplication | undefined
        const launch = async () => {
            app = await openVSCode(workspaceDir)
            const page = await app.firstWindow()
            await E2ETestHelper.openClineSidebar(page)
            const sidebar = await helper.getSidebar(page)
            await E2ETestHelper.dismissWhatsNewModal(sidebar)
            await helper.signin(sidebar)
            return { page, sidebar }
        }
        try {
            const host: ThinkingHost = {
                ...(await launch()),
                restart: async () => {
                    if (!app) throw new Error("No VS Code host to restart")
                    await app.close()
                    app = undefined
                    helper.clearCachedFrame()
                    const reopened = await launch()
                    host.page = reopened.page
                    host.sidebar = reopened.sidebar
                },
            }
            try {
                await use(host)
            } finally {
                if (testInfo.status !== testInfo.expectedStatus && !host.page.isClosed()) {
                    await attachShot(testInfo, "anthropic-thinking-failure", host.page)
                }
            }
        } finally {
            await app?.close()
            helper.clearCachedFrame()
        }
    },
})

function escapeName(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

async function openProfile(host: ThinkingHost): Promise<Locator> {
    const { page, sidebar } = host
    await page.getByRole("button", { name: "Settings", exact: true }).click()
    await expect(sidebar.getByRole("heading", { name: "API Configuration", exact: true })).toBeVisible()
    const card = sidebar.getByTestId("api-profile-card").filter({
        has: sidebar.getByRole("button", { name: new RegExp(`^(Expand|Collapse) ${escapeName(PROFILE_NAME)}$`) }),
    })
    await expect(card).toHaveCount(1)
    const expand = card.getByRole("button", { name: /^Expand / })
    if (await expand.isVisible()) await expand.click()
    await expect(card.getByRole("button", { name: /^Collapse / })).toBeVisible()
    // Positive readiness assertion makes a missing thinking control meaningful.
    await expect(card.getByRole("combobox", { name: "Provider", exact: true })).toBeVisible()
    await expect(card.getByRole("button", { name: "Model Configuration", exact: true })).toBeVisible()
    return card
}

async function closeSettings(host: ThinkingHost): Promise<void> {
    await host.sidebar.getByRole("button", { name: "Done", exact: true }).click()
    await expect(host.sidebar.getByRole("heading", { name: "API Configuration", exact: true })).toHaveCount(0)
    await expect(host.sidebar.getByTestId("chat-input")).toBeEnabled()
}

function thinkingToggle(card: Locator): Locator {
    return card.locator("vscode-checkbox").filter({ hasText: "Enable Thinking" })
}

async function expectToggle(card: Locator, enabled: boolean): Promise<void> {
    const checkbox = thinkingToggle(card)
    await expect(checkbox).toHaveCount(1)
    await expect(checkbox).toBeVisible()
    await expect.poll(() => checkbox.evaluate((element) => Boolean((element as HTMLInputElement).checked))).toBe(enabled)
}

async function setThinking(card: Locator, enabled: boolean): Promise<void> {
    const checkbox = thinkingToggle(card)
    await expect(checkbox).toHaveCount(1)
    await expect(checkbox).toBeVisible()
    const current = await checkbox.evaluate((element) => Boolean((element as HTMLInputElement).checked))
    if (current !== enabled) await checkbox.click()
    await expectToggle(card, enabled)
}

async function selectOption(card: Locator, sidebar: Frame, name: string, option: string): Promise<void> {
    const trigger = card.getByRole("combobox", { name, exact: true })
    await expect(trigger).toBeVisible()
    await trigger.click()
    // Radix portals belong to the frame, not the Profile card.
    await sidebar.getByRole("option", { name: option, exact: true }).click()
    await expect(trigger).toHaveText(option)
}

function displaySelect(card: Locator): Locator {
    return card.getByText("Thinking Display", { exact: true }).locator("..").getByRole("combobox")
}

async function selectDisplay(card: Locator, sidebar: Frame, option: string): Promise<void> {
    const trigger = displaySelect(card)
    await expect(trigger).toHaveCount(1)
    await trigger.click()
    await sidebar.getByRole("option", { name: option, exact: true }).click()
    await expect(trigger).toHaveText(option)
}

/** Observe the write boundary after every edit, without writing expected values. */
async function waitPreferences(dlineDir: string, reasoning: ReasoningConfig, mode?: string): Promise<StoredProfile> {
    await expect
        .poll(
            async () => {
                const profile = await readProfile(dlineDir)
                return { mode: profile.anthropic?.capabilities?.thinking?.mode, reasoning: profile.anthropic?.reasoning ?? {} }
            },
            { timeout: 15_000 },
        )
        .toEqual({ mode, reasoning })
    const profile = await readProfile(dlineDir)
    // Absence on disk, rather than a falsy 0/empty string, is the contract.
    if (reasoning.effort === undefined) expect(profile.anthropic?.reasoning ?? {}).not.toHaveProperty("effort")
    if (reasoning.thinkingBudget === undefined) expect(profile.anthropic?.reasoning ?? {}).not.toHaveProperty("thinkingBudget")
    return profile
}

function expectIdentity(before: StoredProfile, after: StoredProfile): void {
    for (const key of ["id", "name", "provider", "modelId", "baseUrl", "enabled", "usedFor"] as const) {
        expect(after[key], `Profile ${key} must survive a thinking edit`).toEqual(before[key])
    }
    expect(after.modelInfo).toBeUndefined()
}

function expectManual(profile: StoredProfile, mode: "effort" | "budget"): void {
    expect(profile.anthropic?.customModelEnabled).toBe(true)
    expect(profile.anthropic?.capabilities).toMatchObject({
        supportsTools: true,
        contextWindow: 131_072,
        maxTokens: 8192,
        supportsReasoning: true,
        thinking: { supported: true, mode },
    })
    const thinking = profile.anthropic?.capabilities?.thinking
    expect(thinking).not.toHaveProperty("defaultEffort")
    expect(thinking).not.toHaveProperty("minBudget")
    expect(thinking).not.toHaveProperty("maxBudget")
    if (mode === "effort") expect(thinking?.effortLevels).toEqual(MANUAL_EFFORTS)
    expect(profile.modelInfo).toBeUndefined()
}

function expectUndeclared(profile: StoredProfile): void {
    expect(profile.modelId).toBe(MANUAL_MODEL)
    expect(profile.modelInfo).toBeUndefined()
    expect(profile.anthropic?.capabilities).not.toHaveProperty("supportsReasoning")
    expect(profile.anthropic?.capabilities).not.toHaveProperty("thinking")
    expect(profile.anthropic?.reasoning ?? {}).not.toHaveProperty("effort")
    expect(profile.anthropic?.reasoning ?? {}).not.toHaveProperty("thinkingBudget")
}

async function expectPlaceholder(card: Locator): Promise<void> {
    await expect(card.getByRole("combobox", { name: "Thinking Mode", exact: true })).toHaveText("Choose a thinking mode")
    await expect(card.getByRole("combobox", { name: "Adaptive Thinking", exact: true })).toHaveCount(0)
    await expect(card.getByRole("spinbutton", { name: "Thinking Budget", exact: true })).toHaveCount(0)
    await expect(card.getByRole("slider", { name: /^Thinking Budget:/ })).toHaveCount(0)
}

async function setBudget(card: Locator, value: number): Promise<void> {
    const input = card.getByRole("spinbutton", { name: "Thinking Budget", exact: true })
    await expect(input).toBeVisible()
    await expect(input).toBeEnabled()
    await input.fill(String(value))
    // Unknown maxima use a number field whose public commit boundary is blur.
    await input.press("Tab")
    await expect(input).toHaveValue(String(value))
}

async function setCatalogBudget(card: Locator): Promise<void> {
    const slider = card.getByRole("slider", { name: /^Thinking Budget:/ })
    await expect(slider).toBeVisible()
    await expect(slider).toHaveAttribute("min", "1024")
    await expect(slider).toHaveAttribute("max", "4096")
    const box = await slider.boundingBox()
    if (!box) throw new Error("Known budget slider has no bounds")
    // A real pointer gesture commits on mouse-up; no DOM value/event injection.
    await slider.click({ position: { x: box.width - 1, y: box.height / 2 } })
    await expect(slider).toHaveValue("4096")
}

async function selectProfile(sidebar: Frame): Promise<void> {
    const switcher = sidebar.getByRole("button", { name: "Select model", exact: true })
    if ((await switcher.innerText()).trim() !== PROFILE_NAME) {
        await switcher.click()
        await expect(sidebar.getByText("Available Models", { exact: true })).toBeVisible()
        const option = sidebar.getByRole("option").filter({ has: sidebar.getByText(PROFILE_NAME, { exact: true }) })
        await expect(option).toHaveCount(1)
        await option.click()
    }
    await expect(switcher).toHaveText(PROFILE_NAME)
    await expect(sidebar.getByRole("switch", { name: "Act", exact: true })).toHaveAttribute("aria-checked", "true")
}

async function completeTask(
    host: ThinkingHost,
    server: ClineApiServerMock,
    testInfo: TestInfo,
    stage: string,
    choice: RequestChoice,
): Promise<void> {
    const inputMarker = `E2E_ANTHROPIC_${stage}_INPUT`
    const resultMarker = `E2E_ANTHROPIC_${stage}_DONE`
    server.resetOpenAiMock()
    server.enqueueResponses("anthropic-messages", {
        type: "tool",
        id: `call_anthropic_${stage.toLowerCase()}`,
        name: "attempt_completion",
        arguments: { result: resultMarker },
        expectedRequestIncludes: [inputMarker],
    })
    await selectProfile(host.sidebar)
    const input = host.sidebar.getByTestId("chat-input")
    await expect(input).toBeEnabled()
    await input.fill(inputMarker)
    await host.sidebar.getByTestId("send-button").click()
    await expect(host.sidebar.getByText(resultMarker, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
    await expect.poll(() => server.getRequestCount("anthropic-messages")).toBe(1)
    const consumptions = server.getMockConsumptions("anthropic-messages")
    // Retain successful evidence before the fixture removes its isolated data.
    // Headers/authorization are deliberately excluded, even though this key is fake.
    await testInfo.attach(`${stage.toLowerCase()}-consumptions`, {
        body: Buffer.from(
            JSON.stringify(
                consumptions.map((request) => ({
                    target: request.target,
                    protocol: request.protocol,
                    path: request.path,
                    responseType: request.responseType,
                    toolName: request.toolName,
                    toolCallId: request.toolCallId,
                    toolArguments: request.toolArguments,
                    contractError: request.contractError,
                    thinking: request.thinking,
                    requestBody: request.requestBody,
                })),
                null,
                2,
            ),
        ),
        contentType: "application/json",
    })
    await attachShot(testInfo, `${stage.toLowerCase()}-completed`, host.page)
    expect(consumptions).toHaveLength(1)
    const request = consumptions[0]
    expect(request).toMatchObject({
        protocol: "anthropic-messages",
        target: "anthropic-messages",
        responseType: "tool",
        toolName: "attempt_completion",
        toolArguments: { result: resultMarker },
    })
    expect(request.contractError).toBeUndefined()
    expect(request.requestBody).toMatchObject({ model: choice.modelId })
    if (!choice.thinking) {
        expect(request.thinking).toBeUndefined()
        expect(request.requestBody).not.toHaveProperty("thinking")
        expect(request.requestBody).not.toHaveProperty("output_config")
    } else {
        expect(request.thinking).toEqual(choice.thinking)
        const display = choice.display ? { display: choice.display } : {}
        if (choice.thinking.mode === "effort") {
            expect(request.requestBody).toHaveProperty("thinking", { type: "adaptive", ...display })
            expect(request.requestBody).toHaveProperty("output_config", { effort: choice.thinking.effort })
        } else {
            expect(request.requestBody).toHaveProperty("thinking", {
                type: "enabled",
                budget_tokens: choice.thinking.budget,
                ...display,
            })
            expect(request.requestBody).not.toHaveProperty("output_config")
        }
        expect(request.requestBody).not.toHaveProperty("temperature")
    }
}

thinkingE2e(
    "Anthropic Profile thinking - untouched and cancelled manual choices stay undeclared on disk and on the wire",
    async ({ dlineDir, host, server, userDataDir }, testInfo) => {
        thinkingE2e.setTimeout(120_000)
        let card = await openProfile(host)
        const before = await readProfile(dlineDir)
        expectUndeclared(before)
        expect(before.anthropic?.reasoning).toBeUndefined()
        await expectToggle(card, false)
        await expect(card.getByRole("combobox", { name: "Thinking Mode", exact: true })).toHaveCount(0)
        await closeSettings(host)
        const untouched = await waitPreferences(dlineDir, {})
        expectUndeclared(untouched)
        await attachProfile(testInfo, "untouched-profile", untouched)
        await completeTask(host, server, testInfo, "UNTOUCHED", { modelId: MANUAL_MODEL })

        card = await openProfile(host)
        await setThinking(card, true)
        await expectPlaceholder(card)
        const enabled = await waitPreferences(dlineDir, { enableThinking: true })
        expectUndeclared(enabled)
        const mode = card.getByRole("combobox", { name: "Thinking Mode", exact: true })
        await mode.click()
        await expect(host.sidebar.getByRole("option", { name: "Effort", exact: true })).toBeVisible()
        await expect(host.sidebar.getByRole("option", { name: "Budget", exact: true })).toBeVisible()
        // Radix hides the background trigger from accessibility while the portal is open.
        await host.page.keyboard.press("Escape")
        await expectPlaceholder(card)
        await attachShot(testInfo, "cancelled-mode-placeholder", host.page)
        await setThinking(card, false)
        await expect(mode).toHaveCount(0)
        const cancelled = await waitPreferences(dlineDir, { enableThinking: false })
        expectUndeclared(cancelled)
        expectIdentity(before, cancelled)
        await closeSettings(host)
        card = await openProfile(host)
        await expectToggle(card, false)
        await setThinking(card, true)
        await expectPlaceholder(card)
        await waitPreferences(dlineDir, { enableThinking: true })
        await setThinking(card, false)
        const final = await waitPreferences(dlineDir, { enableThinking: false })
        expectUndeclared(final)
        await attachProfile(testInfo, "cancelled-profile", final)
        await closeSettings(host)
        await completeTask(host, server, testInfo, "CANCELLED", { modelId: MANUAL_MODEL })
        await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
    },
)

thinkingE2e(
    "Anthropic Profile thinking - manual Effort clears Budget, preserves display and survives host restart into a High request",
    async ({ dlineDir, host, server, userDataDir }, testInfo) => {
        thinkingE2e.setTimeout(180_000)
        let card = await openProfile(host)
        const before = await readProfile(dlineDir)
        const catalog = await readCatalog(dlineDir)
        expect(catalog.models[KNOWN_EFFORT]?.capabilities?.thinking?.mode).toBe("effort")
        expect(catalog.models[MANUAL_MODEL]).toBeUndefined()
        expectUndeclared(before)
        await expectToggle(card, false)
        await setThinking(card, true)
        await expectPlaceholder(card)
        expectUndeclared(await waitPreferences(dlineDir, { enableThinking: true }))
        await selectDisplay(card, host.sidebar, "Omitted")
        await waitPreferences(dlineDir, { enableThinking: true, display: "omitted" })
        await selectOption(card, host.sidebar, "Thinking Mode", "Budget")
        expectManual(await waitPreferences(dlineDir, { enableThinking: true, display: "omitted" }, "budget"), "budget")
        await setBudget(card, 2048)
        await waitPreferences(dlineDir, { enableThinking: true, thinkingBudget: 2048, display: "omitted" }, "budget")
        await selectOption(card, host.sidebar, "Thinking Mode", "Effort")
        const switched = await waitPreferences(dlineDir, { enableThinking: true, display: "omitted" }, "effort")
        expectManual(switched, "effort")
        await expect(card.getByRole("spinbutton", { name: "Thinking Budget", exact: true })).toHaveCount(0)
        await expect(displaySelect(card)).toHaveText("Omitted")
        const effort = card.getByRole("combobox", { name: "Adaptive Thinking", exact: true })
        await expect(effort).toHaveText("Provider default")
        await effort.click()
        await expect(host.sidebar.getByRole("option")).toHaveText(EFFORT_LABELS)
        await host.sidebar.getByRole("option", { name: "High", exact: true }).click()
        await waitPreferences(dlineDir, { enableThinking: true, effort: "high", display: "omitted" }, "effort")
        // Existing disable/re-enable operations clear preferences, not the manual declaration or display.
        await setThinking(card, false)
        await waitPreferences(dlineDir, { enableThinking: false, display: "omitted" }, "effort")
        await setThinking(card, true)
        await expect(effort).toHaveText("Provider default")
        await waitPreferences(dlineDir, { enableThinking: true, display: "omitted" }, "effort")
        await selectOption(card, host.sidebar, "Adaptive Thinking", "High")
        const saved = await waitPreferences(dlineDir, { enableThinking: true, effort: "high", display: "omitted" }, "effort")
        expectManual(saved, "effort")
        expectIdentity(before, saved)
        await attachProfile(testInfo, "manual-effort-saved", saved)
        await attachShot(testInfo, "manual-effort-settings", host.page)
        await closeSettings(host)

        await host.restart()
        card = await openProfile(host)
        await expectToggle(card, true)
        await expect(card.getByRole("combobox", { name: "Thinking Mode", exact: true })).toHaveText("Effort")
        await expect(card.getByRole("combobox", { name: "Adaptive Thinking", exact: true })).toHaveText("High")
        await expect(displaySelect(card)).toHaveText("Omitted")
        const reopened = await readProfile(dlineDir)
        expectIdentity(before, reopened)
        expectManual(reopened, "effort")
        expect(reopened.anthropic?.reasoning).toEqual({ enableThinking: true, effort: "high", display: "omitted" })
        const unchanged = await readCatalog(dlineDir)
        expect(unchanged.models[MANUAL_MODEL]).toBeUndefined()
        expect(unchanged.models[KNOWN_EFFORT]).toEqual(catalog.models[KNOWN_EFFORT])
        await attachProfile(testInfo, "manual-effort-reopened", reopened)
        await attachShot(testInfo, "manual-effort-reopened-settings", host.page)
        await closeSettings(host)
        await completeTask(host, server, testInfo, "MANUAL_EFFORT", {
            modelId: MANUAL_MODEL,
            thinking: { mode: "effort", effort: "high" },
            display: "omitted",
        })
        await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
    },
)

thinkingE2e(
    "Anthropic Profile thinking - manual Budget stays selected while empty, clears Effort and restarts into a 2048-token request",
    async ({ dlineDir, host, server, userDataDir }, testInfo) => {
        thinkingE2e.setTimeout(180_000)
        let card = await openProfile(host)
        const before = await readProfile(dlineDir)
        expectUndeclared(before)
        await expectToggle(card, false)
        await setThinking(card, true)
        await expectPlaceholder(card)
        expectUndeclared(await waitPreferences(dlineDir, { enableThinking: true }))
        await selectOption(card, host.sidebar, "Thinking Mode", "Effort")
        await expect(card.getByRole("combobox", { name: "Adaptive Thinking", exact: true })).toHaveText("Provider default")
        expectManual(await waitPreferences(dlineDir, { enableThinking: true }, "effort"), "effort")
        await selectOption(card, host.sidebar, "Adaptive Thinking", "High")
        await waitPreferences(dlineDir, { enableThinking: true, effort: "high" }, "effort")
        await selectDisplay(card, host.sidebar, "Summarized")
        await waitPreferences(dlineDir, { enableThinking: true, effort: "high", display: "summarized" }, "effort")
        await selectOption(card, host.sidebar, "Thinking Mode", "Budget")
        const empty = await waitPreferences(dlineDir, { enableThinking: true, display: "summarized" }, "budget")
        expectManual(empty, "budget")
        await expect(card.getByRole("combobox", { name: "Adaptive Thinking", exact: true })).toHaveCount(0)
        await expect(card.getByRole("spinbutton", { name: "Thinking Budget", exact: true })).toHaveValue("")
        await attachProfile(testInfo, "manual-budget-empty", empty)
        await closeSettings(host)
        // Reopening before entering a value catches mode inference from budget > 0.
        card = await openProfile(host)
        await expectToggle(card, true)
        await expect(card.getByRole("combobox", { name: "Thinking Mode", exact: true })).toHaveText("Budget")
        await expect(card.getByRole("spinbutton", { name: "Thinking Budget", exact: true })).toBeEnabled()
        await expect(displaySelect(card)).toHaveText("Summarized")
        await waitPreferences(dlineDir, { enableThinking: true, display: "summarized" }, "budget")
        await attachShot(testInfo, "manual-budget-empty-settings", host.page)
        await setBudget(card, 2048)
        const saved = await waitPreferences(
            dlineDir,
            { enableThinking: true, thinkingBudget: 2048, display: "summarized" },
            "budget",
        )
        expectManual(saved, "budget")
        expectIdentity(before, saved)
        await attachProfile(testInfo, "manual-budget-saved", saved)
        await closeSettings(host)

        await host.restart()
        card = await openProfile(host)
        await expectToggle(card, true)
        await expect(card.getByRole("combobox", { name: "Thinking Mode", exact: true })).toHaveText("Budget")
        await expect(card.getByRole("spinbutton", { name: "Thinking Budget", exact: true })).toHaveValue("2048")
        await expect(card.getByRole("combobox", { name: "Adaptive Thinking", exact: true })).toHaveCount(0)
        await expect(displaySelect(card)).toHaveText("Summarized")
        const reopened = await readProfile(dlineDir)
        expectManual(reopened, "budget")
        expectIdentity(before, reopened)
        expect(reopened.anthropic?.reasoning).toEqual({ enableThinking: true, thinkingBudget: 2048, display: "summarized" })
        expect((await readCatalog(dlineDir)).models[MANUAL_MODEL]).toBeUndefined()
        await attachProfile(testInfo, "manual-budget-reopened", reopened)
        await attachShot(testInfo, "manual-budget-reopened-settings", host.page)
        await closeSettings(host)
        await completeTask(host, server, testInfo, "MANUAL_BUDGET", {
            modelId: MANUAL_MODEL,
            thinking: { mode: "budget", budget: 2048 },
            display: "summarized",
        })
        await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
    },
)

for (const thinkingCase of ["supports-false", "thinking-false"] as const) {
    thinkingE2e.describe(thinkingCase, () => {
        thinkingE2e.use({ thinkingCase })
        thinkingE2e(
            `Anthropic Profile thinking - explicit ${thinkingCase === "supports-false" ? "supportsReasoning:false" : "thinking.supported:false"} forbids manual controls and thinking requests`,
            async ({ dlineDir, host, server, userDataDir }, testInfo) => {
                const card = await openProfile(host)
                const before = await readProfile(dlineDir)
                await expect(thinkingToggle(card)).toHaveCount(0)
                await expect(card.getByRole("combobox", { name: "Thinking Mode", exact: true })).toHaveCount(0)
                await expect(card.getByRole("combobox", { name: "Adaptive Thinking", exact: true })).toHaveCount(0)
                await expect(card.getByRole("spinbutton", { name: "Thinking Budget", exact: true })).toHaveCount(0)
                await expect(card.getByRole("slider", { name: /^Thinking Budget:/ })).toHaveCount(0)
                await attachShot(testInfo, `${thinkingCase}-settings`, host.page)
                await closeSettings(host)
                const saved = await waitPreferences(dlineDir, {})
                expectIdentity(before, saved)
                expect(saved.anthropic?.reasoning).toBeUndefined()
                if (thinkingCase === "supports-false") {
                    expect(saved.anthropic?.capabilities?.supportsReasoning).toBe(false)
                    expect(saved.anthropic?.capabilities?.thinking).toBeUndefined()
                } else {
                    expect(saved.anthropic?.capabilities?.thinking).toMatchObject({ supported: false })
                    expect(saved.anthropic?.capabilities?.thinking).not.toHaveProperty("mode")
                    expect(saved.anthropic?.capabilities?.supportsReasoning).toBeUndefined()
                }
                await attachProfile(testInfo, `${thinkingCase}-profile`, saved)
                await completeTask(
                    host,
                    server,
                    testInfo,
                    thinkingCase === "supports-false" ? "SUPPORTS_FALSE" : "THINKING_FALSE",
                    {
                        modelId: MANUAL_MODEL,
                    },
                )
                await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
            },
        )
    })
}

for (const mode of ["effort", "budget"] as const) {
    thinkingE2e.describe(`known-${mode}`, () => {
        thinkingE2e.use({ thinkingCase: mode === "effort" ? "known-effort" : "known-budget" })
        thinkingE2e(
            `Anthropic Profile thinking - catalog-known ${mode} keeps its single control and Enable/Disable/Enable through restart and completion`,
            async ({ dlineDir, host, server, userDataDir }, testInfo) => {
                thinkingE2e.setTimeout(180_000)
                let card = await openProfile(host)
                const before = await readProfile(dlineDir)
                const modelId = mode === "effort" ? KNOWN_EFFORT : KNOWN_BUDGET
                const declaration = (await readCatalog(dlineDir)).models[modelId]
                expect(declaration?.capabilities?.thinking).toMatchObject({ supported: true, mode })
                expect(before.anthropic?.capabilities?.thinking).toBeUndefined()
                expect(before.anthropic?.reasoning).toBeUndefined()
                await expectToggle(card, false)
                await expect(card.getByRole("combobox", { name: "Thinking Mode", exact: true })).toHaveCount(0)
                await setThinking(card, true)
                await waitPreferences(dlineDir, { enableThinking: true })
                await selectDisplay(card, host.sidebar, "Omitted")
                if (mode === "effort") {
                    await expect(card.getByRole("slider", { name: /^Thinking Budget:/ })).toHaveCount(0)
                    await expect(card.getByRole("spinbutton", { name: "Thinking Budget", exact: true })).toHaveCount(0)
                    await selectOption(card, host.sidebar, "Adaptive Thinking", "High")
                } else {
                    expect(declaration?.userDefined).toBe(true)
                    await expect(card.getByRole("combobox", { name: "Adaptive Thinking", exact: true })).toHaveCount(0)
                    await setCatalogBudget(card)
                }
                const preference: ReasoningConfig = {
                    enableThinking: true,
                    ...(mode === "effort" ? { effort: "high" } : { thinkingBudget: 4096 }),
                    display: "omitted",
                }
                await waitPreferences(dlineDir, preference)
                await expect(card.getByRole("combobox", { name: "Thinking Mode", exact: true })).toHaveCount(0)
                await setThinking(card, false)
                await waitPreferences(dlineDir, { enableThinking: false, display: "omitted" })
                await expect(card.getByRole("combobox", { name: "Adaptive Thinking", exact: true })).toHaveCount(0)
                await expect(card.getByRole("slider", { name: /^Thinking Budget:/ })).toHaveCount(0)
                await setThinking(card, true)
                await waitPreferences(dlineDir, { enableThinking: true, display: "omitted" })
                await expect(displaySelect(card)).toHaveText("Omitted")
                if (mode === "effort") {
                    await expect(card.getByRole("combobox", { name: "Adaptive Thinking", exact: true })).toHaveText(
                        "Provider default",
                    )
                    await selectOption(card, host.sidebar, "Adaptive Thinking", "High")
                } else {
                    await setCatalogBudget(card)
                }
                const saved = await waitPreferences(dlineDir, preference)
                expectIdentity(before, saved)
                expect(saved.anthropic?.capabilities?.thinking).toBeUndefined()
                expect(saved.anthropic?.capabilities?.supportsReasoning).toBeUndefined()
                await attachProfile(testInfo, `known-${mode}-saved`, saved)
                await attachShot(testInfo, `known-${mode}-settings`, host.page)
                await closeSettings(host)

                await host.restart()
                card = await openProfile(host)
                await expectToggle(card, true)
                await expect(card.getByRole("combobox", { name: "Thinking Mode", exact: true })).toHaveCount(0)
                await expect(displaySelect(card)).toHaveText("Omitted")
                if (mode === "effort") {
                    await expect(card.getByRole("combobox", { name: "Adaptive Thinking", exact: true })).toHaveText("High")
                    await expect(card.getByRole("slider", { name: /^Thinking Budget:/ })).toHaveCount(0)
                } else {
                    await expect(card.getByRole("slider", { name: /^Thinking Budget:/ })).toHaveValue("4096")
                    await expect(card.getByRole("combobox", { name: "Adaptive Thinking", exact: true })).toHaveCount(0)
                }
                const reopened = await waitPreferences(dlineDir, preference)
                expectIdentity(before, reopened)
                expect(reopened.anthropic?.capabilities?.thinking).toBeUndefined()
                expect((await readCatalog(dlineDir)).models[modelId]).toEqual(declaration)
                await attachProfile(testInfo, `known-${mode}-reopened`, reopened)
                await attachShot(testInfo, `known-${mode}-reopened-settings`, host.page)
                await closeSettings(host)
                await completeTask(host, server, testInfo, mode === "effort" ? "KNOWN_EFFORT" : "KNOWN_BUDGET", {
                    modelId,
                    thinking: mode === "effort" ? { mode, effort: "high" } : { mode, budget: 4096 },
                    display: "omitted",
                })
                await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
            },
        )
    })
}
