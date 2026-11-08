import { readFile } from "node:fs/promises"
import path from "node:path"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { MultiInstanceLauncher } from "@e2e/utils/multi-instance"
import { resizePrimarySidebar } from "@e2e/utils/resize-primary-sidebar"
import { expect, type Frame, type Page, type TestInfo } from "@playwright/test"
import type { ElectronApplication } from "playwright"

const devWebview = process.env.DLINE_E2E_DEV_WEBVIEW === "true"
e2e.use({ profileMode: "mock", isolateOsHome: true, installVsix: false, devWebview })

async function settings(
    dlineDir: string,
): Promise<{ uiLanguage?: string; preferredLanguage?: string; aggressiveRendering?: string }> {
    return JSON.parse(await readFile(path.join(dlineDir, "data", "settings", "settings.json"), "utf8"))
}
async function general(page: Page, frame: Frame): Promise<void> {
    await page.getByRole("button", { name: "Settings", exact: true }).click()
    await frame.getByTestId("tab-general").click()
    await expect(frame.locator("#ui-language-dropdown")).toBeVisible()
    if (devWebview) {
        await expect(frame.locator('script[type="module"][src$="/src/main.tsx"]')).toHaveCount(1)
    }
}
async function choose(frame: Frame, value: "auto" | "en" | "zh-CN"): Promise<void> {
    const dropdown = frame.locator("#ui-language-dropdown")
    await dropdown.click()
    await dropdown.locator(`vscode-option[value="${value}"]`).click()
    await expect.poll(() => dropdown.evaluate((element) => (element as HTMLSelectElement).value)).toBe(value)
}
async function expectLanguage(frame: Frame, language: "en" | "zh-CN"): Promise<void> {
    await expect(frame.locator("html")).toHaveAttribute("lang", language)
    await expect(frame.getByRole("button", { name: language === "en" ? "Done" : "完成", exact: true })).toBeVisible()
    await expect(
        frame.getByRole("combobox", { name: language === "en" ? "Interface language" : "界面语言", exact: true }),
    ).toBeVisible()
}
async function newPanel(page: Page): Promise<Frame> {
    const existing = new Set(page.frames())
    await page.getByRole("button", { name: "New Task", exact: true }).click()
    let result: Frame | undefined
    await expect
        .poll(
            async () => {
                for (const frame of page.frames()) {
                    if (existing.has(frame) || frame.isDetached() || !frame.url().startsWith("vscode-webview://")) continue
                    if ((await frame.locator("#root").count()) > 0) {
                        result = frame
                        return true
                    }
                }
                return false
            },
            { timeout: 30_000 },
        )
        .toBe(true)
    if (!result) throw new Error("Dline editor panel was not created")
    await E2ETestHelper.dismissWhatsNewModal(result)
    return result
}
async function captureFailure(page: Page | undefined, testInfo: TestInfo): Promise<void> {
    if (!page || page.isClosed()) return
    try {
        await page.screenshot({ path: testInfo.outputPath("ui-language-failure.png"), fullPage: true, timeout: 5_000 })
    } catch (error) {
        await testInfo.attach("screenshot-error.txt", { body: String(error), contentType: "text/plain" })
    }
}

e2e(
    "UI language defaults to auto, switches live and survives settings reopen and host restart",
    async ({ openVSCode, workspaceDir, helper, dlineDir, userDataDir, server }, testInfo) => {
        e2e.setTimeout(240_000)
        let app: ElectronApplication | undefined
        let page: Page | undefined
        try {
            app = await openVSCode(workspaceDir, {}, { locale: "en" })
            page = await app.firstWindow()
            await E2ETestHelper.openClineSidebar(page)
            const sidebar = await helper.getSidebar(page)
            await helper.signin(sidebar)
            await general(page, sidebar)
            await expect
                .poll(() => sidebar.locator("#ui-language-dropdown").evaluate((element) => (element as HTMLSelectElement).value))
                .toBe("auto")
            await expectLanguage(sidebar, "en")
            const modelPreference = (await settings(dlineDir)).preferredLanguage ?? "English"
            const generationRequests = server.openAiRequestCount
            await sidebar.locator("#ui-language-dropdown").evaluate((element) => {
                element.setAttribute("data-e2e-identity", "original-control")
            })
            await choose(sidebar, "zh-CN")
            await expectLanguage(sidebar, "zh-CN")
            await expect(sidebar.locator("#ui-language-dropdown")).toHaveAttribute("data-e2e-identity", "original-control")
            await expect.poll(async () => (await settings(dlineDir)).uiLanguage).toBe("zh-CN")
            await sidebar.getByRole("button", { name: "完成", exact: true }).click()
            await general(page, sidebar)
            await expectLanguage(sidebar, "zh-CN")
            await choose(sidebar, "en")
            await expectLanguage(sidebar, "en")
            await choose(sidebar, "auto")
            await expectLanguage(sidebar, "en")
            await expect.poll(async () => (await settings(dlineDir)).uiLanguage).toBe("auto")
            await choose(sidebar, "zh-CN")
            await expectLanguage(sidebar, "zh-CN")
            await expect.poll(async () => (await settings(dlineDir)).uiLanguage).toBe("zh-CN")
            expect((await settings(dlineDir)).preferredLanguage ?? "English").toBe(modelPreference)
            expect(server.openAiRequestCount).toBe(generationRequests)
            await app.close()
            app = undefined

            app = await openVSCode(workspaceDir, {}, { locale: "en" })
            page = await app.firstWindow()
            await E2ETestHelper.openClineSidebar(page)
            const reopened = await helper.getSidebar(page)
            await helper.signin(reopened)
            await general(page, reopened)
            await expectLanguage(reopened, "zh-CN")
            await choose(reopened, "auto")
            await expectLanguage(reopened, "en")
            await expect.poll(async () => (await settings(dlineDir)).uiLanguage).toBe("auto")
            expect((await settings(dlineDir)).preferredLanguage ?? "English").toBe(modelPreference)
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } catch (error) {
            await captureFailure(page, testInfo)
            throw error
        } finally {
            await app?.close()
        }
    },
)

e2e(
    "UI language converges across the sidebar, an existing editor panel and a newly opened panel",
    async ({ openVSCode, workspaceDir, helper, dlineDir, userDataDir }, testInfo) => {
        e2e.setTimeout(240_000)
        let app: ElectronApplication | undefined
        let page: Page | undefined
        try {
            app = await openVSCode(workspaceDir, {}, { locale: "en" })
            page = await app.firstWindow()
            await E2ETestHelper.openClineSidebar(page)
            const sidebar = await helper.getSidebar(page)
            await helper.signin(sidebar)
            const existing = await newPanel(page)
            await expect(existing.locator("html")).toHaveAttribute("lang", "en")
            await general(page, sidebar)
            await choose(sidebar, "zh-CN")
            await expectLanguage(sidebar, "zh-CN")
            await expect(existing.locator("html")).toHaveAttribute("lang", "zh-CN")
            await expect.poll(async () => (await settings(dlineDir)).uiLanguage).toBe("zh-CN")
            const fresh = await newPanel(page)
            await expect(fresh.locator("html")).toHaveAttribute("lang", "zh-CN")
            // VS Code owns navigation chrome; editor panels do not expose the standalone Navbar.
            await choose(sidebar, "auto")
            await expect(fresh.locator("html")).toHaveAttribute("lang", "en")
            // Verify the covered Webview at its user-visible reveal boundary.
            await page.locator(".part.editor").getByRole("tab", { name: "Dline", exact: true }).first().click()
            await expect(existing.locator("html")).toHaveAttribute("lang", "en")
            await expectLanguage(sidebar, "en")
            await expect.poll(async () => (await settings(dlineDir)).uiLanguage).toBe("auto")
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } catch (error) {
            await captureFailure(page, testInfo)
            throw error
        } finally {
            await app?.close()
        }
    },
)

e2e(
    "UI language switches during a streaming Task and General dropdown choices retain their values",
    async ({ openVSCode, workspaceDir, helper, dlineDir, userDataDir, server }, testInfo) => {
        e2e.setTimeout(240_000)
        let app: ElectronApplication | undefined
        let page: Page | undefined
        server.resetOpenAiMock()
        server.enqueueOpenAiResponses({
            type: "tool",
            name: "qna_respond",
            arguments: { response: "LANGUAGE_STREAM ".repeat(500) },
            toolArgumentChunkSize: 16,
            toolArgumentChunkDelayMs: 50,
        })
        try {
            app = await openVSCode(workspaceDir, { DLINE_EXPERIMENTAL_AGGRESSIVE_RENDERING: "true" }, { locale: "en" })
            page = await app.firstWindow()
            await E2ETestHelper.openClineSidebar(page)
            const sidebar = await helper.getSidebar(page)
            await helper.signin(sidebar)
            await general(page, sidebar)
            await expect(sidebar.locator('#ui-language-dropdown vscode-option[value="auto"]')).toHaveText("Auto")
            for (const [value, name] of [
                ["message_segment", "Per message segment"],
                ["round", "Per request"],
                ["user_turn", "Per user turn"],
                ["none", "No folding"],
            ] as const) {
                await sidebar.locator("#aggressive-rendering").click()
                await sidebar.getByRole("option", { name, exact: true }).click()
                await expect.poll(async () => (await settings(dlineDir)).aggressiveRendering).toBe(value)
                await expect
                    .poll(() =>
                        sidebar.locator("#aggressive-rendering").evaluate((element) => (element as HTMLSelectElement).value),
                    )
                    .toBe(value)
            }
            await sidebar.getByRole("button", { name: "Done", exact: true }).click()
            await sidebar.getByTestId("chat-input").fill("Keep streaming while I change the interface language.")
            await sidebar.getByTestId("send-button").click()
            await expect.poll(() => server.openAiRequestCount).toBe(1)
            await expect(sidebar.getByTestId("send-button")).toHaveAttribute("data-action", "cancel")
            await general(page, sidebar)
            await choose(sidebar, "zh-CN")
            await expectLanguage(sidebar, "zh-CN")
            await expect(sidebar.locator('#ui-language-dropdown vscode-option[value="auto"]')).toHaveText("自动")
            await expect(sidebar.locator('#aggressive-rendering [slot="selected-value"]')).toHaveText("不折叠")
            await expect.poll(async () => (await settings(dlineDir)).uiLanguage).toBe("zh-CN")
            await expect(sidebar.getByTestId("send-button")).toHaveAttribute("data-action", "cancel")
            await choose(sidebar, "en")
            await expectLanguage(sidebar, "en")
            await choose(sidebar, "auto")
            await expectLanguage(sidebar, "en")
            await expect.poll(async () => (await settings(dlineDir)).uiLanguage).toBe("auto")
            await expect(sidebar.getByTestId("send-button")).toHaveAttribute("data-action", "cancel")
            expect(server.openAiRequestCount).toBe(1)
            await sidebar.getByRole("button", { name: "Done", exact: true }).click()
            await sidebar.getByTestId("send-button").click()
            await expect(sidebar.getByTestId("send-button")).not.toHaveAttribute("data-action", "cancel")
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } catch (error) {
            await captureFailure(page, testInfo)
            throw error
        } finally {
            await app?.close()
        }
    },
)

e2e(
    "UI language translates Settings, history and MCP across windows without losing a draft or search",
    async ({ workspaceDir, dlineDir, dlineDocsDir, extensionsDir, server }, testInfo) => {
        e2e.setTimeout(240_000)
        const launcher = new MultiInstanceLauncher({
            dlineDir,
            dlineDocsDir,
            extensionsDir,
            server,
            testInfo,
            workspaceDir,
            environment: { IS_DEV: "true", DLINE_E2E_DEV_WEBVIEW: String(devWebview) },
        })
        const draft = "KEEP original unsent draft / 用户原文"
        const query = "KEEP history search"
        const renderDiagnostics: string[] = []
        try {
            const browsing = await launcher.launch("language-browsing")
            const controlling = await launcher.launch("language-settings")
            const { page, sidebar } = browsing
            page.on("pageerror", (error) => renderDiagnostics.push(error.stack ?? error.message))
            page.on("console", (message) => {
                if (message.type() === "error") renderDiagnostics.push(message.text())
            })
            const panel = controlling.sidebar
            await sidebar.getByTestId("chat-input").fill(draft)
            const generationRequests = server.openAiRequestCount
            await general(controlling.page, panel)
            await choose(panel, "zh-CN")
            await expectLanguage(panel, "zh-CN")

            await general(page, sidebar)
            await sidebar.getByTestId("tab-features").click()
            await expect(sidebar.getByRole("switch", { name: "自动压缩", exact: true })).toBeVisible()
            await page.screenshot({ path: testInfo.outputPath("ui-language-zh-settings.png"), fullPage: true })
            await sidebar.getByTestId("tab-browser").click()
            await expect(sidebar.getByText("禁用浏览器工具", { exact: true })).toBeVisible()
            await sidebar.getByTestId("tab-terminal").click()
            await expect(sidebar.getByText("终端命令超时（分钟）", { exact: true })).toBeVisible()
            await sidebar.getByRole("button", { name: "完成", exact: true }).click()
            await expect(sidebar.getByTestId("chat-input")).toHaveText(draft)

            // Native VS Code toolbar labels belong to the host, not the Webview preference.
            await page.getByRole("button", { name: "History", exact: true }).click()
            await expect(sidebar.getByRole("heading", { name: /历史/ })).toBeVisible()
            const chineseSearch = sidebar.getByRole("textbox", { name: "模糊搜索历史…", exact: true })
            await chineseSearch.fill(query)
            await chineseSearch.evaluate((element) => element.setAttribute("data-e2e-identity", "history-search"))
            await choose(panel, "en")
            await expectLanguage(panel, "en")
            await expect(sidebar.getByRole("heading", { name: "History", exact: true })).toBeVisible()
            const englishSearch = sidebar.getByRole("textbox", { name: "Fuzzy search history...", exact: true })
            await expect(englishSearch).toHaveValue(query)
            await expect(englishSearch).toHaveAttribute("data-e2e-identity", "history-search")
            await sidebar.getByRole("button", { name: "Done", exact: true }).click()
            await expect(sidebar.getByTestId("chat-input")).toHaveText(draft)

            await page.getByRole("button", { name: "MCP Servers", exact: true }).click()
            await expect(sidebar.getByRole("heading", { name: "MCP Servers", exact: true })).toBeVisible()
            await choose(panel, "zh-CN")
            await expect(sidebar.getByRole("heading", { name: "MCP 服务器", exact: true })).toBeVisible()
            await sidebar.getByRole("button", { name: "配置", exact: true }).click()
            await expect(sidebar.getByRole("button", { name: "配置 MCP 服务器", exact: true })).toBeVisible()
            await page.screenshot({ path: testInfo.outputPath("ui-language-zh-mcp.png"), fullPage: true })
            await choose(panel, "en")
            await expect(sidebar.getByRole("heading", { name: "MCP Servers", exact: true })).toBeVisible()
            await sidebar.getByRole("button", { name: "Done", exact: true }).click()
            await expect(sidebar.getByTestId("chat-input")).toHaveText(draft)
            expect(server.openAiRequestCount).toBe(generationRequests)
            await E2ETestHelper.expectNoUnexpectedDlineErrors(browsing.userDataDir)
            await E2ETestHelper.expectNoUnexpectedDlineErrors(controlling.userDataDir)
        } finally {
            if (renderDiagnostics.length > 0) {
                await testInfo.attach("history-render-diagnostics.txt", {
                    body: renderDiagnostics.join("\n\n"),
                    contentType: "text/plain",
                })
            }
            await launcher.dispose()
        }
    },
)

e2e(
    "Model response language localizes its options and persists Auto independently of the interface",
    async ({ openVSCode, workspaceDir, helper, dlineDir, userDataDir, server }, testInfo) => {
        e2e.setTimeout(240_000)
        let app: ElectronApplication | undefined
        let page: Page | undefined
        server.resetOpenAiMock()
        server.enqueueOpenAiResponses({ type: "tool", name: "qna_respond", arguments: { response: "MODEL_LANGUAGE_AUTO_READY" } })
        try {
            app = await openVSCode(workspaceDir, {}, { locale: "en" })
            page = await app.firstWindow()
            await E2ETestHelper.openClineSidebar(page)
            const sidebar = await helper.getSidebar(page)
            await helper.signin(sidebar)
            await general(page, sidebar)
            const model = sidebar.locator("#preferred-language-dropdown")
            await expect(model).toHaveAccessibleName("Model response language")
            await expect(model.locator('vscode-option[value="Simplified Chinese - 简体中文"]')).toHaveText("Simplified Chinese")
            await model.click()
            await model.getByRole("option", { name: "Simplified Chinese", exact: true }).click()
            await expect.poll(async () => (await settings(dlineDir)).preferredLanguage).toBe("Simplified Chinese - 简体中文")
            await expect(model.locator('[slot="selected-value"]')).toHaveText("Simplified Chinese")
            await choose(sidebar, "zh-CN")
            await expectLanguage(sidebar, "zh-CN")
            await expect(model).toHaveAccessibleName("模型沟通语言")
            await expect(model.locator('[slot="selected-value"]')).toHaveText("简体中文")
            await model.click()
            await expect(model.getByRole("option", { name: "英语", exact: true })).toBeVisible()
            await model.getByRole("option", { name: "自动", exact: true }).click()
            await expect.poll(async () => (await settings(dlineDir)).preferredLanguage).toBe("auto")
            await expect(sidebar.locator("html")).toHaveAttribute("lang", "zh-CN")
            await choose(sidebar, "en")
            await expectLanguage(sidebar, "en")
            await expect(model.locator('[slot="selected-value"]')).toHaveText("Auto")
            expect((await settings(dlineDir)).preferredLanguage).toBe("auto")
            await sidebar.getByRole("button", { name: "Done", exact: true }).click()
            const userText = "请检查自动语言偏好，保留这条中文消息原文。"
            await sidebar.getByTestId("chat-input").fill(userText)
            await sidebar.getByTestId("send-button").click()
            await expect(sidebar.getByText("MODEL_LANGUAGE_AUTO_READY", { exact: true })).toBeVisible()
            const request = server.getMockConsumptions("openai-compatible-chat")[0]
            const body = request.requestBody as { messages: Array<{ role: string; content: unknown }> }
            const system = JSON.stringify(
                body.messages.filter((message) => message.role === "system" || message.role === "developer"),
            )
            expect(system).toContain("Use the language of the user's most recent message")
            expect(system).not.toContain("# Preferred Language\\n\\nSpeak in en.")
            expect(JSON.stringify(body.messages.filter((message) => message.role === "user"))).toContain(userText)
            expect(request.contractError).toBeUndefined()
            await app.close()
            app = undefined
            app = await openVSCode(workspaceDir, {}, { locale: "en" })
            page = await app.firstWindow()
            await E2ETestHelper.openClineSidebar(page)
            const reopened = await helper.getSidebar(page)
            await helper.signin(reopened)
            await general(page, reopened)
            await expect(reopened.locator('#preferred-language-dropdown [slot="selected-value"]')).toHaveText("Auto")
            expect((await settings(dlineDir)).preferredLanguage).toBe("auto")
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } catch (error) {
            await captureFailure(page, testInfo)
            throw error
        } finally {
            await app?.close()
        }
    },
)

async function generalLayout(frame: Frame) {
    return frame.evaluate(() => {
        const ids = ["ui-language-dropdown", "preferred-language-dropdown", "chat-input-send-shortcut", "aggressive-rendering"]
        const controls = ids.map((id) => document.getElementById(id)!)
        const labels = ids.map((id) => document.querySelector(`label[for="${id}"]`)!)
        const fields = controls.map((control) => control.closest(".profile-field")!)
        const descriptions = [
            "ui-language-description",
            "ui-language-auto-description",
            "ui-language-coverage",
            "preferred-language-description",
            "aggressive-rendering-description",
        ].map((id) => document.getElementById(id)!)
        const typography = (element: Element) => {
            const style = getComputedStyle(element)
            return { size: Number.parseFloat(style.fontSize), lineHeight: Number.parseFloat(style.lineHeight) }
        }
        const paragraphs = [...new Set(descriptions.map((element) => element.closest("p")!))]
        return {
            labels: labels.map(typography),
            values: controls.map((control) => typography(control.querySelector('[slot="selected-value"]')!)),
            descriptions: descriptions.map(typography),
            paragraphs: paragraphs.map((paragraph) => {
                const style = getComputedStyle(paragraph)
                return {
                    top: style.marginTop,
                    bottom: style.marginBottom,
                    clamp: style.webkitLineClamp,
                    visible: paragraph.clientHeight >= paragraph.scrollHeight,
                }
            }),
            gaps: fields
                .slice(1)
                .map((field, index) => field.getBoundingClientRect().top - fields[index].getBoundingClientRect().bottom),
            fieldMargins: fields.map((field) => [getComputedStyle(field).marginTop, getComputedStyle(field).marginBottom]),
            rem: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
            fits: controls.every((control) => {
                const box = control.getBoundingClientRect()
                return box.left >= 0 && box.right <= window.innerWidth + 1 && box.width > 0
            }),
            overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
            valuesKept: controls.map((control) => (control as HTMLSelectElement).value),
        }
    })
}

e2e(
    "General settings keep consistent typography and spacing in both languages at narrow and wide widths",
    async ({ openVSCode, workspaceDir, helper, userDataDir, server }, testInfo) => {
        e2e.setTimeout(240_000)
        let app: ElectronApplication | undefined
        let page: Page | undefined
        try {
            app = await openVSCode(workspaceDir, { DLINE_EXPERIMENTAL_AGGRESSIVE_RENDERING: "true" }, { locale: "en" })
            page = await app.firstWindow()
            await E2ETestHelper.openClineSidebar(page)
            const sidebar = await helper.getSidebar(page)
            await helper.signin(sidebar)
            await general(page, sidebar)
            const requests = server.openAiRequestCount
            for (const id of [
                "ui-language-dropdown",
                "preferred-language-dropdown",
                "chat-input-send-shortcut",
                "aggressive-rendering",
            ]) {
                await sidebar.locator(`#${id}`).evaluate((element) => element.setAttribute("data-e2e-identity", "original"))
            }
            const baseline = (await generalLayout(sidebar)).valuesKept.slice(1)
            for (const width of [320, 700]) {
                await resizePrimarySidebar(page, width)
                for (const language of ["en", "zh-CN", "en"] as const) {
                    await choose(sidebar, language)
                    await expectLanguage(sidebar, language)
                    const layout = await generalLayout(sidebar)
                    await testInfo.attach(`general-${language}-${width}-metrics.json`, {
                        body: JSON.stringify(layout, null, 2),
                        contentType: "application/json",
                    })
                    expect(layout.labels).toHaveLength(4)
                    for (const label of layout.labels) expect(label).toEqual(layout.labels[0])
                    for (const value of layout.values) expect(value.size).toBeCloseTo(layout.labels[0].size, 2)
                    for (const description of layout.descriptions) {
                        expect(description.size / layout.labels[0].size).toBeCloseTo(0.85 / 0.95, 2)
                        expect(description.lineHeight / description.size).toBeCloseTo(1.5, 2)
                    }
                    for (const paragraph of layout.paragraphs)
                        expect(paragraph).toEqual({ top: "0px", bottom: "0px", clamp: "none", visible: true })
                    for (const gap of layout.gaps) expect(gap).toBeCloseTo(layout.rem, 0)
                    for (const margins of layout.fieldMargins) expect(margins).toEqual(["0px", "0px"])
                    expect(layout.fits).toBe(true)
                    expect(layout.overflow).toBe(false)
                    expect(layout.valuesKept.slice(1)).toEqual(baseline)
                    await expect(sidebar.locator('vscode-dropdown[data-e2e-identity="original"]')).toHaveCount(4)
                    await page.screenshot({ path: testInfo.outputPath(`general-${language}-${width}.png`), fullPage: true })
                }
            }
            expect(server.openAiRequestCount).toBe(requests)
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } catch (error) {
            await captureFailure(page, testInfo)
            throw error
        } finally {
            await app?.close()
        }
    },
)
