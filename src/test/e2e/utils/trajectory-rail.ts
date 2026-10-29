import { expect, type Frame, type Locator } from "@playwright/test"

/** Accessible-name prefix every rail bar carries before the turn's prompt. */
const JUMP_LABEL_PREFIX = "Jump to message: "

/** One bar of the rail: the user message it jumps to. */
export interface TrajectoryRailTurn {
    readonly anchorTs: number
    readonly prompt: string
}

/** What a bar's hover card reports about its turn. */
export interface TrajectoryTurnPreview {
    readonly rounds: number
    readonly tools: ReadonlyArray<{ readonly tool: string; readonly count: number }>
}

/**
 * The conversation trajectory rail of the chat, read through its accessible
 * names and test ids rather than its geometry.
 *
 * The rail stays mounted while hidden; only its opacity and pointer events
 * change. Focusing a bar both engages the rail and opens the bar's preview, so
 * the helpers never depend on a scroll having just revealed it.
 */
export function trajectoryRail(sidebar: Frame) {
    const rail = sidebar.getByTestId("trajectory-rail")
    const bar = (prompt: string): Locator => rail.getByRole("button", { name: `${JUMP_LABEL_PREFIX}${prompt}`, exact: true })

    /** The rail's turns grouped by attempt, in display order; empty when no rail is drawn. */
    async function attempts(): Promise<TrajectoryRailTurn[][]> {
        const groups = await rail.getByTestId("trajectory-attempt").evaluateAll((nodes) =>
            nodes.map((node) =>
                Array.from(node.querySelectorAll('[data-testid="trajectory-turn"]')).map((button) => ({
                    anchorTs: Number(button.getAttribute("data-turn-ts")),
                    label: button.getAttribute("aria-label") ?? "",
                })),
            ),
        )
        return groups.map((turns) =>
            turns.map(({ anchorTs, label }) => ({
                anchorTs,
                prompt: label.startsWith(JUMP_LABEL_PREFIX) ? label.slice(JUMP_LABEL_PREFIX.length) : label,
            })),
        )
    }

    /** The prompts of every attempt, the shape most assertions compare. */
    async function prompts(): Promise<string[][]> {
        return (await attempts()).map((turns) => turns.map((turn) => turn.prompt))
    }

    /** Opens the bar's hover card, reads its rounds and tool counts, then closes it again. */
    async function preview(prompt: string): Promise<TrajectoryTurnPreview> {
        const target = bar(prompt)
        await target.focus()
        const card = sidebar.getByTestId("trajectory-turn-preview").filter({ hasText: prompt })
        await expect(card).toBeVisible()
        const parsed = await card.evaluate((node) => {
            const roundsLabel = Array.from(node.querySelectorAll("span"))
                .map((span) => span.textContent?.trim() ?? "")
                .find((text) => /^\d+ rounds?$/.test(text))
            const tools = Array.from(node.querySelectorAll("li")).map((item) => {
                const [name, count] = Array.from(item.querySelectorAll("span"))
                return {
                    tool: name?.textContent?.trim() ?? "",
                    count: Number((count?.textContent ?? "").replace("×", "").trim()),
                }
            })
            // A turn without rounds draws no summary section at all.
            return { rounds: roundsLabel ? Number.parseInt(roundsLabel, 10) : 0, tools }
        })
        await target.blur()
        await expect(card).toBeHidden()
        return parsed
    }

    /** Clicks the bar of the turn whose user message is `prompt`. */
    async function jumpTo(prompt: string): Promise<void> {
        const target = bar(prompt)
        // Focus engages the rail first, so the click is not refused by the hidden rail's pointer-events.
        await target.focus()
        await target.click()
    }

    return { rail, bar, attempts, prompts, preview, jumpTo }
}
