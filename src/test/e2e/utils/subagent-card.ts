import { expect, type Frame, type Locator } from "@playwright/test"

/**
 * The newest chat Work card of the subagent run whose task contains `task`.
 *
 * Cards open folded. The task then shows in the header summary, and in the Task
 * section once the card is open, so this locator holds in both states.
 */
export function subagentCardByTask(scope: Frame | Locator, task: string | RegExp): Locator {
    return scope.getByTestId("subagent-item").filter({ hasText: task }).last()
}

/** The header control that opens a folded Work card, present only while the card is folded. */
export function subagentCardOpenControl(card: Locator): Locator {
    return card.getByTestId("subagent-item-header").getByRole("button", { name: /^Expand subagent / })
}

/**
 * Open a folded Work card so its Task, Tools, and Output render. A card that is
 * already open is left as it is.
 */
export async function openSubagentCard(card: Locator): Promise<void> {
    const open = subagentCardOpenControl(card)
    const close = card.getByTestId("subagent-item-header").getByRole("button", { name: /^Collapse subagent / })
    await expect(open.or(close)).toBeVisible()
    if (await open.isVisible()) await open.click()
    await expect(card.getByTestId("subagent-item-body")).toBeVisible()
}

/**
 * Open a Work card and its Output section, which stays closed until asked, and
 * return the completed result. The section appears only once the run settled,
 * so `timeout` bounds the wait for that.
 */
export async function showSubagentOutput(card: Locator, timeout = 60_000): Promise<Locator> {
    await openSubagentCard(card)
    const show = card.getByRole("button", { name: "Show subagent output", exact: true })
    const hide = card.getByRole("button", { name: "Hide subagent output", exact: true })
    await expect(show.or(hide)).toBeVisible({ timeout })
    if (await show.isVisible()) await show.click()
    return card.getByTestId("subagent-output")
}
