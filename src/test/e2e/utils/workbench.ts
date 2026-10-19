import path from "node:path"
import { expect, type Locator, type Page } from "@playwright/test"

/** Text area of the active editor group, where an opened workspace file is rendered. */
export function activeEditorLines(page: Page): Locator {
    return page.locator(".part.editor .view-lines").last()
}

/**
 * Open a workspace file through Quick Open and wait until its editor tab is visible.
 *
 * @param relativePath workspace-relative path typed into Quick Open; its base name labels the tab.
 */
export async function openWorkspaceFile(page: Page, relativePath: string): Promise<void> {
    const fileName = path.posix.basename(relativePath)
    await page.keyboard.press("ControlOrMeta+p")
    const quickInput = page.locator(".quick-input-widget input").last()
    await expect(quickInput).toBeVisible()
    await quickInput.fill(relativePath)

    const fileOption = page.locator(".quick-input-widget .monaco-list-row").filter({ hasText: fileName }).first()
    await expect(fileOption).toBeVisible()
    await fileOption.click()

    await expect(page.getByRole("tab", { name: fileName, exact: true })).toBeVisible()
}
