import type { AccountUsageData } from "@shared/ExtensionMessage"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, userEvent, within } from "storybook/test"
import { createStorybookDecorator } from "@/config/StorybookDecorator"
import { ProviderUsage } from "./ProviderUsage"
import {
    balanceUsageFixture,
    claudeFableExhaustedUsageFixture,
    claudeUsageFixture,
    codexUsageFixture,
    openCodeBalanceUsageFixture,
    openCodeGoPlusUsageFixture,
    openCodeGoTeamsUsageFixture,
    openCodeGoUsageFixture,
    openCodeNoDataUsageFixture,
    unreportedCacheUsageFixture,
    zeroCacheHitUsageFixture,
} from "./usageStoryFixtures"

/**
 * The settings-page usage card, framed like the Provider section it sits in.
 *
 * Stories render in on-demand mode so the card shows the snapshot the backend
 * published for the active Profile instead of calling the RPC, which has no
 * backend in Storybook.
 */
function ProviderUsageCardFixture({ title }: { title: string }) {
    return (
        <div className="flex w-[360px] flex-col rounded-xs border border-editor-widget-border p-3">
            <span className="text-sm font-medium text-foreground">{title}</span>
            <ProviderUsage enabled pollIntervalMs={null} profileId="profile-story" />
        </div>
    )
}

const withUsage = (accountUsage: AccountUsageData) => [createStorybookDecorator({ accountUsage }, "p-6")]

/** Expand the card so the review sees the detail rows, not only the summary line. */
const expandCard: Story["play"] = async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const toggle = canvas.getByRole("button", { name: /^Usage / })
    await userEvent.click(toggle)
    await expect(toggle).toHaveAttribute("aria-expanded", "true")
}

const meta = {
    title: "Settings/Providers/ProviderUsage",
    component: ProviderUsageCardFixture,
    parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ProviderUsageCardFixture>

export default meta
type Story = StoryObj<typeof meta>

/** Balance and local day totals, including a measured 75% cache hit rate. */
export const Balance: Story = {
    args: { title: "DeepSeek" },
    decorators: withUsage(balanceUsageFixture),
    play: async (context) => {
        await expandCard(context)
        await expect(within(context.canvasElement).getByText("Cache hit: 75%")).toBeVisible()
    },
}

/** A reported zero must render as 0%, not disappear as unknown. */
export const CacheHitZero: Story = {
    args: { title: "DeepSeek" },
    decorators: withUsage(zeroCacheHitUsageFixture),
    play: async (context) => {
        await expandCard(context)
        await expect(within(context.canvasElement).getByText("Cache hit: 0%")).toBeVisible()
    },
}

/** A missing cache split must not be presented as a measured zero. */
export const CacheNotReported: Story = {
    args: { title: "DeepSeek" },
    decorators: withUsage(unreportedCacheUsageFixture),
    play: async (context) => {
        await expandCard(context)
        const canvas = within(context.canvasElement)
        await expect(canvas.getByText(/^Today In:/)).toBeVisible()
        await expect(canvas.queryByText(/^Cache hit:/)).not.toBeInTheDocument()
    },
}

/** Codex subscription: rolling "5 hour" / "7 day" windows with reset cards. */
export const Codex: Story = {
    args: { title: "OpenAI Codex" },
    decorators: withUsage(codexUsageFixture),
    play: expandCard,
}

/** Claude subscription: "5 hour", calendar "This week" and the per-model "Fable this week". */
export const Claude: Story = {
    args: { title: "Claude Code" },
    decorators: withUsage(claudeUsageFixture),
    play: expandCard,
}

/** Claude with the Fable weekly cap exhausted. */
export const ClaudeFableExhausted: Story = {
    args: { title: "Claude Code" },
    decorators: withUsage(claudeFableExhaustedUsageFixture),
    play: expandCard,
}

/**
 * OpenCode pay-as-you-go: Dline accumulates the per-response cost, and shows
 * no remaining balance because Console publishes no balance endpoint.
 */
export const OpenCodeBalance: Story = {
    args: { title: "OpenCode" },
    decorators: withUsage(openCodeBalanceUsageFixture),
    play: expandCard,
}

/** OpenCode Go ($10/month): three windows against the plan's per-model limit. */
export const OpenCodeGo: Story = {
    args: { title: "OpenCode" },
    decorators: withUsage(openCodeGoUsageFixture),
    play: expandCard,
}

/** OpenCode Go Plus ($40/month): the same windows against a higher limit. */
export const OpenCodeGoPlus: Story = {
    args: { title: "OpenCode" },
    decorators: withUsage(openCodeGoPlusUsageFixture),
    play: expandCard,
}

/**
 * OpenCode Go Teams ($20/member/month). Read beside `OpenCodeGo` this is the
 * story that makes a monthly limit derived from `billing_source` visibly
 * wrong: the gateway reports `go` for a Teams member, but the limit differs.
 */
export const OpenCodeGoTeams: Story = {
    args: { title: "OpenCode" },
    decorators: withUsage(openCodeGoTeamsUsageFixture),
    play: expandCard,
}

/**
 * No cost has been reported yet. The card stays collapsed and says so instead
 * of drawing an empty window that would read as "nothing used".
 */
export const OpenCodeNoData: Story = {
    args: { title: "OpenCode" },
    decorators: withUsage(openCodeNoDataUsageFixture),
}
