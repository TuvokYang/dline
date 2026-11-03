import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import * as path from "node:path"
import { type E2EMockProviderTarget, getE2EMockProviderUrl } from "@e2e/fixtures/server/api"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame, type Locator } from "@playwright/test"
import type { ElectronApplication } from "playwright"

const PROFILE_ID = "bug263-opencode"
const PROFILE_NAME = "BUG263 OpenCode"
const MODEL_ID = "bug263-effort-model"
const EFFORTS = ["low", "medium", "high", "xhigh", "max"]
const protocols = [
    { format: "OPENAI_CHAT", target: "openai-compatible-chat", endpoint: "/openai/v1/chat/completions" },
    { format: "OPENAI_RESPONSES", target: "openai-compatible-responses", endpoint: "/openai/v1/responses" },
    { format: "ANTHROPIC_CHAT", target: "anthropic-messages", endpoint: "/anthropic/v1/messages" },
] as const

type StoredProfile = {
    id: string
    name: string
    opencode?: {
        reasoning?: { enableThinking?: boolean; effort?: string }
        capabilities?: { contextWindow?: number; maxTokens?: number }
    }
}

async function readJson<T>(file: string): Promise<T> {
    return JSON.parse(await readFile(file, "utf8")) as T
}

/** Adapt only gateway paths; the existing mock owns protocol streams and tools. */
async function gatewayProxy(mockBaseUrl: string) {
    const paths: string[] = []
    const gateway = createServer(async (request, response) => {
        paths.push(request.url ?? "")
        const protocol = protocols.find((candidate) => candidate.endpoint === request.url)
        if (!protocol) {
            response.writeHead(404).end()
            return
        }
        try {
            const chunks: Buffer[] = []
            for await (const chunk of request) chunks.push(Buffer.from(chunk))
            const headers: Record<string, string> = { "Content-Type": "application/json" }
            for (const name of ["authorization", "x-api-key", "anthropic-version"]) {
                const value = request.headers[name]
                if (typeof value === "string") headers[name] = value
            }
            const upstream = await fetch(getE2EMockProviderUrl(mockBaseUrl, protocol.target), {
                method: "POST",
                headers,
                body: Buffer.concat(chunks),
                signal: AbortSignal.timeout(30_000),
            })
            response.writeHead(upstream.status, { "Content-Type": upstream.headers.get("content-type") ?? "text/event-stream" })
            response.end(Buffer.from(await upstream.arrayBuffer()))
        } catch (error) {
            response.writeHead(502).end(error instanceof Error ? error.message : String(error))
        }
    })
    await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve))
    const address = gateway.address()
    if (!address || typeof address === "string") throw new Error("Gateway proxy has no TCP address")
    return {
        paths,
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>((resolve, reject) => gateway.close((error) => (error ? reject(error) : resolve()))),
    }
}

/** Seed only this test's private roots, before its VS Code process starts. */
async function seedProfile(
    dlineDir: string,
    baseUrl: string,
    format: string,
    options: { emptyReasoning?: boolean; legacyConflict?: boolean; go?: boolean } = {},
) {
    const profilesPath = path.join(dlineDir, "data", "settings", "api_profiles.json")
    const settingsPath = path.join(dlineDir, "data", "settings", "settings.json")
    const keysPath = path.join(dlineDir, "data", "secrets", "api_keys.json")
    const profiles = await readJson<StoredProfile[]>(profilesPath)
    const settings = await readJson<Record<string, unknown>>(settingsPath)
    const keys = await readJson<Record<string, unknown>>(keysPath)
    const model = {
        id: MODEL_ID,
        apiFormats: ["OPENAI_RESPONSES", "OPENAI_CHAT", "ANTHROPIC_CHAT"],
        capabilities: {
            contextWindow: 1_000_000,
            maxTokens: 8192,
            supportsTools: true,
            supportsReasoning: true,
            thinking: { supported: true, mode: "effort", effortLevels: EFFORTS },
        },
    }
    const config = {
        mode: options.go ? "OPEN_CODE_MODE_GO" : "OPEN_CODE_MODE_CONSOLE",
        apiFormat: format,
        ...(!options.emptyReasoning ? { reasoning: { enableThinking: true, effort: "low" } } : {}),
        capabilities: { contextWindow: 262_144, maxTokens: 4096 },
        ...(options.legacyConflict
            ? {
                  model: {
                      apiFormat: format,
                      reasoning: { enableThinking: true, effort: "high" },
                      capabilities: { contextWindow: 1_000_000, maxTokens: 8192 },
                  },
              }
            : {}),
    }
    const profile = {
        id: PROFILE_ID,
        name: PROFILE_NAME,
        provider: "opencode",
        modelId: MODEL_ID,
        enabled: true,
        usedFor: ["plan", "act"],
        baseUrl,
        webToolsMode: "WEB_TOOLS_MODE_FORCE_OFF",
        opencode: config,
    }
    const providersDir = path.join(dlineDir, "providers")
    await mkdir(providersDir, { recursive: true })
    await Promise.all([
        writeFile(profilesPath, `${JSON.stringify([...profiles, profile], null, 2)}\n`),
        writeFile(
            keysPath,
            `${JSON.stringify({ ...keys, [PROFILE_ID]: { apiKey: "bug263-local-mock-key", name: PROFILE_NAME } }, null, 2)}\n`,
        ),
        writeFile(
            settingsPath,
            `${JSON.stringify({ ...settings, mode: "act", planModeProfileId: PROFILE_ID, planModeProfile: PROFILE_NAME, actModeProfileId: PROFILE_ID, actModeProfile: PROFILE_NAME }, null, 2)}\n`,
        ),
        writeFile(
            path.join(providersDir, "opencode.json"),
            `${JSON.stringify(
                {
                    provider: "opencode",
                    providerName: "OpenCode",
                    models: { [MODEL_ID]: model },
                    defaultModelId: MODEL_ID,
                    catalogs: { "opencode-go": { models: { [MODEL_ID]: model }, defaultModelId: MODEL_ID } },
                },
                null,
                2,
            )}\n`,
        ),
    ])
    return profilesPath
}

async function send(sidebar: Frame, text: string) {
    const input = sidebar.getByTestId("chat-input")
    await expect(input).toBeEnabled({ timeout: 60_000 })
    await input.fill(text)
    await input.press("Enter")
}

async function selectEffort(sidebar: Frame, control: Locator, effort: string) {
    await control.click()
    await sidebar.getByRole("option", { name: effort, exact: true }).click()
}

async function taskSettings(dlineDocsDir: string): Promise<Record<string, unknown>> {
    const root = path.join(dlineDocsDir, "tasks")
    const taskId = await E2ETestHelper.waitForValue(async () => {
        const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
        return entries.find((entry) => entry.isDirectory())?.name
    })
    // A task that has not overridden any setting need not materialize this file.
    return readJson<Record<string, unknown>>(path.join(root, taskId, "settings.json")).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return {}
        throw error
    })
}

function requestEffort(body: unknown, target: E2EMockProviderTarget): unknown {
    const request = body as { reasoning_effort?: string; reasoning?: { effort?: string }; output_config?: { effort?: string } }
    return target === "openai-compatible-chat"
        ? request.reasoning_effort
        : target === "anthropic-messages"
          ? request.output_config?.effort
          : request.reasoning?.effort
}

e2e.use({ isolateOsHome: true })

for (const protocol of protocols) {
    e2e(
        `BUG263 ${protocol.format}: inherits Profile, honors Task override and never replays legacy limits`,
        async ({ dlineDir, dlineDocsDir, helper, openVSCode, server, workspaceDir, userDataDir }, testInfo) => {
            e2e.setTimeout(180_000)
            server.resetOpenAiMock()
            const gateway = await gatewayProxy(server.baseUrl)
            await seedProfile(dlineDir, gateway.baseUrl, protocol.format, { legacyConflict: true, go: true })
            let app: ElectronApplication | undefined
            try {
                app = await openVSCode(workspaceDir)
                const page = await app.firstWindow()
                await E2ETestHelper.openClineSidebar(page)
                const sidebar = await helper.getSidebar(page)
                await helper.signin(sidebar)
                for (const marker of ["BUG263_INHERITED", "BUG263_OVERRIDDEN"]) {
                    server.enqueueResponses(protocol.target, {
                        type: "tool",
                        name: "qna_respond",
                        arguments: { response: marker },
                    })
                }
                await send(sidebar, "BUG263 request with no temporary thinking override")
                await expect.poll(() => gateway.paths[0]).toBe(protocol.endpoint)
                await expect(sidebar.getByText("BUG263_INHERITED", { exact: true })).toBeVisible({ timeout: 60_000 })
                const thinking = sidebar.getByRole("combobox", { name: "Task thinking override" })
                await expect(thinking).toHaveText("Low")
                const saved = await taskSettings(dlineDocsDir)
                expect(saved.actModeReasoningOverrideKind).toBeUndefined()
                const first = server.getMockConsumptions(protocol.target)[0]
                await testInfo.attach("inherited-request", {
                    body: JSON.stringify(first.requestBody, null, 2),
                    contentType: "application/json",
                })
                expect(first.contractError).toBeUndefined()
                expect(requestEffort(first.requestBody, protocol.target)).toBe("low")
                expect(first.requestBody).toMatchObject(
                    protocol.target === "openai-compatible-responses" ? { max_output_tokens: 4096 } : { max_tokens: 4096 },
                )
                const expand = sidebar.getByLabel("Expand task header")
                if (await expand.isVisible()) await expand.click()
                await expect(sidebar.getByTestId("context-window-segmented-progress")).toHaveAttribute(
                    "data-context-window",
                    "262144",
                )
                await selectEffort(sidebar, thinking, "Medium")
                await expect.poll(async () => (await taskSettings(dlineDocsDir)).actModeReasoningOverrideEffort).toBe("medium")
                await send(sidebar, "BUG263 request with explicit temporary override")
                await expect(sidebar.getByText("BUG263_OVERRIDDEN", { exact: true })).toBeVisible({ timeout: 60_000 })
                const second = server.getMockConsumptions(protocol.target)[1]
                expect(requestEffort(second.requestBody, protocol.target)).toBe("medium")
                expect(second.contractError).toBeUndefined()
                const profiles = await readJson<StoredProfile[]>(path.join(dlineDir, "data", "settings", "api_profiles.json"))
                expect(profiles.find((profile) => profile.id === PROFILE_ID)?.opencode?.reasoning?.effort).toBe("low")
                await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
            } finally {
                await app?.close()
                await gateway.close()
            }
        },
    )
}

e2e(
    "BUG263 settings edits survive save and restart; unset temporary thinking follows the displayed Profile default",
    async ({ dlineDir, dlineDocsDir, helper, openVSCode, server, workspaceDir, userDataDir }) => {
        e2e.setTimeout(240_000)
        server.resetOpenAiMock()
        const gateway = await gatewayProxy(server.baseUrl)
        const profilesPath = await seedProfile(dlineDir, gateway.baseUrl, "OPENAI_RESPONSES", { emptyReasoning: true })
        let app: ElectronApplication | undefined
        try {
            app = await openVSCode(workspaceDir)
            let page = await app.firstWindow()
            await E2ETestHelper.openClineSidebar(page)
            let sidebar = await helper.getSidebar(page)
            await helper.signin(sidebar)
            server.enqueueResponses("openai-compatible-responses", {
                type: "tool",
                name: "qna_respond",
                arguments: { response: "BUG263_DEFAULT_READY" },
            })
            await send(sidebar, "BUG263 default thinking")
            await expect(sidebar.getByText("BUG263_DEFAULT_READY", { exact: true })).toBeVisible({ timeout: 60_000 })
            await expect.soft(sidebar.getByRole("combobox", { name: "Task thinking override" })).toHaveText("Xhigh")
            expect
                .soft(
                    requestEffort(
                        server.getMockConsumptions("openai-compatible-responses")[0].requestBody,
                        "openai-compatible-responses",
                    ),
                )
                .toBe("xhigh")
            expect((await taskSettings(dlineDocsDir)).actModeReasoningOverrideKind).toBeUndefined()

            await page.getByRole("button", { name: "Settings", exact: true }).click()
            const card = sidebar.getByTestId("api-profile-card").filter({
                has: sidebar.getByRole("button", { name: `Expand ${PROFILE_NAME}`, exact: true }),
            })
            await card.getByRole("button", { name: `Expand ${PROFILE_NAME}`, exact: true }).click()
            const expanded = sidebar.getByTestId("api-profile-card").filter({
                has: sidebar.getByRole("button", { name: `Collapse ${PROFILE_NAME}`, exact: true }),
            })
            const effort = expanded.getByRole("combobox").last()
            await expect(effort).toHaveText("Xhigh")
            await selectEffort(sidebar, effort, "Low")
            await expanded.getByRole("button", { name: "Model Configuration", exact: true }).click()
            const context = expanded.getByRole("textbox", { name: "Context Window Size" })
            await context.fill("196608")
            await context.press("Tab")
            const output = expanded.getByRole("textbox", { name: "Max Output Tokens" })
            await output.fill("3072")
            await output.press("Tab")
            await expect
                .poll(
                    async () =>
                        (await readJson<StoredProfile[]>(profilesPath)).find((profile) => profile.id === PROFILE_ID)?.opencode,
                )
                .toMatchObject({
                    reasoning: { enableThinking: true, effort: "low" },
                    capabilities: { contextWindow: 196608, maxTokens: 3072 },
                })
            await sidebar.getByRole("button", { name: "Done", exact: true }).click()
            await expect(sidebar.getByRole("combobox", { name: "Task thinking override" })).toHaveText("Low")
            await app.close()
            app = undefined
            helper.clearCachedFrame()
            app = await openVSCode(workspaceDir)
            page = await app.firstWindow()
            await E2ETestHelper.openClineSidebar(page)
            sidebar = await helper.getSidebar(page)
            await helper.signin(sidebar)
            await page.getByRole("button", { name: "Settings", exact: true }).click()
            const reopened = sidebar.getByTestId("api-profile-card").filter({
                has: sidebar.getByRole("button", { name: new RegExp(`^(Expand|Collapse) ${PROFILE_NAME}$`) }),
            })
            await expect(reopened).toHaveCount(1)
            const toggle = reopened.getByRole("button", { name: `Expand ${PROFILE_NAME}`, exact: true })
            if (await toggle.isVisible()) await toggle.click()
            await expect(reopened.getByRole("combobox").last()).toHaveText("Low")
            const reopenedContext = reopened.getByRole("textbox", { name: "Context Window Size" })
            if (!(await reopenedContext.isVisible()))
                await reopened.getByRole("button", { name: "Model Configuration", exact: true }).click()
            await expect(reopenedContext).toHaveValue("196608")
            await expect(reopened.getByRole("textbox", { name: "Max Output Tokens" })).toHaveValue("3072")
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await app?.close()
            await gateway.close()
        }
    },
)
