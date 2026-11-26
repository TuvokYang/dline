import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { openWorkCapabilities } from "@e2e/utils/work/policy-resources"
import { expect } from "@playwright/test"

/**
 * BUGFIX-144 regression: the subagent row summary and the editor tab title must
 * reflect real state without waiting for a manual interaction.
 *
 * Both failures were display-only, so the assertions read what a user reads: the
 * row summary text on a folded row, and the panel title in the editor tab bar.
 */

const SUBAGENT_NAME = "e2e-summary-count"

async function writeSubagent(workspaceDir: string): Promise<void> {
    const directory = path.join(workspaceDir, ".agents", "subagents")
    await mkdir(directory, { recursive: true })
    await writeFile(
        path.join(directory, `${SUBAGENT_NAME}.yml`),
        [
            "---",
            `name: ${SUBAGENT_NAME}`,
            "description: Exercises the collapsed tool summary count.",
            "tools:",
            "  - read_file",
            "  - list_files",
            "  - search_files",
            "---",
            "Use the workspace tools and report back.",
        ].join("\n"),
        "utf8",
    )
}

e2e(
    "Capabilities - a folded subagent row reports its real tool count without expansion",
    async ({ helper, sidebar, userDataDir, workspaceDir }) => {
        await writeSubagent(workspaceDir)
        await helper.signin(sidebar)

        const popup = await openWorkCapabilities(sidebar)
        await popup.getByRole("button", { name: "Subagents", exact: true }).click()

        const row = popup.getByText(SUBAGENT_NAME, { exact: true }).locator("xpath=ancestor::div[contains(@class, 'mb-2.5')][1]")
        await expect(row).toBeVisible({ timeout: 60_000 })

        const summary = row.getByText(/^tools: \d+\/\d+ active$/)
        // The summary must resolve to a real ratio instead of staying in its loading state.
        await expect(summary).toBeVisible({ timeout: 60_000 })

        const text = await summary.innerText()
        const [, active, total] = /^tools: (\d+)\/(\d+) active$/.exec(text) ?? []
        const activeCount = Number(active)
        const totalCount = Number(total)

        // The denominator is the whole directory, not the saved selection, and the
        // numerator counts what is actually in effect: the three saved tools plus the
        // required completion tool, all present in the directory.
        expect(totalCount).toBeGreaterThan(3)
        expect(activeCount).toBe(4)
        expect(activeCount).toBeLessThanOrEqual(totalCount)

        // The row is still folded, so this was never computed from an expanded editor.
        await expect(row.getByRole("tab")).toHaveCount(0)

        await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
    },
)
