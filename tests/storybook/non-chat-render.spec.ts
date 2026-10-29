import { type APIRequestContext, expect, type Page, test } from "@playwright/test"

interface StoryIndexEntry {
    id: string
    title: string
    type: string
}

interface StorybookIndex {
    entries: Record<string, StoryIndexEntry>
}

const EXPECTED_STORY_GROUPS = [
    "Ui/Alert",
    "Ui/Badge",
    "Ui/Button",
    "Ui/Dialog",
    "Ui/HoverCard",
    "Ui/Input",
    "Ui/Item",
    "Ui/Popover",
    "Ui/Progress",
    "Ui/Select",
    "Ui/Separator",
    "Ui/Switch",
    "Ui/Tooltip",
    "Views/Components/ErrorRow",
    "Views/Components/MarkdownBlock",
    "Views/Components/McpResponseDisplay",
    "Views/Components/TaskHeader",
    "Views/Components/TypewriterText",
] as const

const SEMANTIC_SELECTORS = new Map<string, string>([
    ["Ui/Button", "button"],
    ["Ui/Input", "input"],
    ["Ui/Progress", '[role="progressbar"]'],
    ["Ui/Select", '[role="combobox"]'],
    ["Ui/Separator", '[role="separator"], [data-orientation]'],
    ["Ui/Switch", '[role="switch"]'],
])

async function loadNonChatStories(request: APIRequestContext): Promise<StoryIndexEntry[]> {
    const response = await request.get("/index.json")
    expect(response.ok()).toBe(true)
    const index = (await response.json()) as StorybookIndex
    return Object.values(index.entries)
        .filter((entry) => entry.type === "story" && entry.title !== "Views/Chat")
        .sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id))
}

async function waitForStablePreview(page: Page): Promise<void> {
    let previousSignature = ""
    let stableCycles = 0

    for (let cycle = 0; cycle < 30; cycle += 1) {
        const signature = await page.evaluate(() => {
            const root = document.querySelector("#storybook-root")
            return `${document.body.className}:${root?.innerHTML.length ?? 0}`
        })
        if (signature === previousSignature) {
            stableCycles += 1
            if (stableCycles >= 3) return
        } else {
            previousSignature = signature
            stableCycles = 0
        }
        await page.waitForTimeout(100)
    }
}

async function openStory(page: Page, storyId: string): Promise<void> {
    const response = await page.goto(`/iframe.html?id=${storyId}&viewMode=story`, {
        waitUntil: "domcontentloaded",
    })
    expect(response?.ok()).toBe(true)
    await expect(page.locator("#storybook-root")).not.toBeEmpty({ timeout: 60_000 })
    await waitForStablePreview(page)
}

// The full smoke pass warms Storybook's lazy Vite compilation before focused interactions.
test.describe.configure({ mode: "serial" })

test.describe("non-Chat Storybook rendering", () => {
    test("every indexed story renders without preview, page, or unexpected console errors", async ({ page, request }) => {
        test.setTimeout(600_000)
        const stories = await loadNonChatStories(request)
        const storyGroups = new Set(stories.map((story) => story.title))
        const failures: string[] = []

        expect(stories.length).toBeGreaterThan(0)
        for (const expectedGroup of EXPECTED_STORY_GROUPS) {
            expect(storyGroups).toContain(expectedGroup)
        }

        for (const story of stories) {
            const pageErrors: string[] = []
            const consoleErrors: string[] = []
            const onPageError = (error: Error) => pageErrors.push(error.message)
            const onConsole = (message: { type(): string; text(): string }) => {
                if (message.type() === "error") consoleErrors.push(message.text())
            }
            page.on("pageerror", onPageError)
            page.on("console", onConsole)

            try {
                await openStory(page, story.id)
                const preview = await page.evaluate(() => {
                    const root = document.querySelector("#storybook-root")
                    const visibleDescendants = root
                        ? Array.from(root.querySelectorAll("*")).filter((element) => {
                              const rect = element.getBoundingClientRect()
                              const style = getComputedStyle(element)
                              return (
                                  rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
                              )
                          }).length
                        : 0
                    return {
                        bodyClass: document.body.className,
                        htmlLength: root?.innerHTML.trim().length ?? 0,
                        textLength: root?.textContent?.trim().length ?? 0,
                        visibleDescendants,
                    }
                })

                if (preview.bodyClass.includes("sb-show-errordisplay") || preview.bodyClass.includes("sb-show-nopreview")) {
                    failures.push(`${story.id}: Storybook preview state ${preview.bodyClass}`)
                }
                if (preview.htmlLength === 0 || (preview.textLength === 0 && preview.visibleDescendants === 0)) {
                    failures.push(
                        `${story.id}: blank preview html=${preview.htmlLength} text=${preview.textLength} visible=${preview.visibleDescendants}`,
                    )
                }

                const semanticSelector = SEMANTIC_SELECTORS.get(story.title)
                if (semanticSelector && (await page.locator(semanticSelector).count()) === 0) {
                    failures.push(`${story.id}: missing semantic element ${semanticSelector}`)
                }
            } catch (error) {
                failures.push(`${story.id}: ${error instanceof Error ? error.message : String(error)}`)
            } finally {
                page.off("pageerror", onPageError)
                page.off("console", onConsole)
            }

            for (const pageError of pageErrors) {
                if (pageError !== "The user aborted a request.") failures.push(`${story.id}: pageerror ${pageError}`)
            }
            for (const consoleError of consoleErrors) {
                failures.push(`${story.id}: console error ${consoleError.split("\n")[0]}`)
            }
        }

        expect(failures, failures.join("\n")).toEqual([])
    })
})

test.describe("non-Chat representative interactions", () => {
    test("Dialog opens its modal content", async ({ page }) => {
        await openStory(page, "ui-dialog--interactive")
        await page.getByRole("button", { name: "Open Dialog", exact: true }).click()
        await expect(page.getByRole("dialog")).toBeVisible()
        await expect(page.getByRole("heading", { name: "Dialog Title", exact: true })).toBeVisible()
    })

    test("Popover opens its floating content", async ({ page }) => {
        await openStory(page, "ui-popover--default")
        await page.getByRole("button", { name: "Open Popover", exact: true }).click()
        await expect(page.getByText("Popover Title", { exact: true })).toBeVisible()
    })

    test("Select commits a chosen value", async ({ page }) => {
        await openStory(page, "ui-select--interactive")
        const trigger = page.getByRole("combobox").first()
        await trigger.click()
        await page.getByRole("option", { name: "Option 1", exact: true }).click()
        await expect(trigger).toContainText("Option 1")
    })

    test("Tooltip appears on hover", async ({ page }) => {
        await openStory(page, "ui-tooltip--default")
        await page.getByRole("button", { name: "Hover for tooltip", exact: true }).hover()
        await expect(page.getByRole("tooltip", { name: "This is a helpful tooltip" })).toBeVisible()
    })

    test("HoverCard appears on hover", async ({ page }) => {
        await openStory(page, "ui-hovercard--default")
        await page.getByRole("button", { name: "Hover over me", exact: true }).hover()
        await expect(page.getByText("Hover Card Title", { exact: true })).toBeVisible()
    })

    test("Switch toggles its accessible checked state", async ({ page }) => {
        await openStory(page, "ui-switch--default")
        const target = page.locator('[role="switch"]').first()
        await expect(target).toHaveAttribute("aria-checked", "false")
        await target.click()
        await expect(target).toHaveAttribute("aria-checked", "true")
    })
})
