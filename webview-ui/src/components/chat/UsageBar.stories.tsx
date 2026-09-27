import type { AccountUsageData } from "@shared/ExtensionMessage"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { createStorybookDecorator } from "@/config/StorybookDecorator"
import {
	balanceUsageFixture,
	claudeFableExhaustedUsageFixture,
	claudeUsageFixture,
	codexUsageFixture,
} from "../settings/providers/usageStoryFixtures"
import { UsageBar } from "./UsageBar"

const withUsage = (accountUsage: AccountUsageData) => [createStorybookDecorator({ accountUsage }, "w-full max-w-none")]

function UsageBarFixture() {
	return (
		<div className="flex h-[520px] w-full items-end justify-end p-6" data-testid="usage-bar-fixture">
			<UsageBar />
		</div>
	)
}

const meta = {
	title: "Chat/UsageBar",
	component: UsageBarFixture,
	parameters: {
		layout: "fullscreen",
	},
	decorators: withUsage(codexUsageFixture),
} satisfies Meta<typeof UsageBarFixture>

export default meta
type Story = StoryObj<typeof meta>

/** Hover the chat-input usage chip so the read-only tooltip preview renders. */
const hoverChip: Story["play"] = async ({ canvasElement }) => {
	await userEvent.hover(within(canvasElement).getByRole("button", { name: "Provider usage" }))
	// The tooltip is portalled to the document body, outside the canvas.
	await waitFor(() => expect(document.querySelector('[data-usage-surface="preview"]')).not.toBeNull())
}

/** Click the chip so the details menu, with its refresh button, renders. */
const openDetails: Story["play"] = async ({ canvasElement }) => {
	await userEvent.click(within(canvasElement).getByRole("button", { name: "Provider usage" }))
	await waitFor(() => expect(document.querySelector('[data-usage-surface="details"]')).not.toBeNull())
}

/** Codex chip: rolling windows, shown as "5h" and "7d". */
export const RemainingCapacity: Story = {}

/** Codex tooltip: plan, both windows, the next reset card and the reading age. */
export const CodexTooltip: Story = { play: hoverChip }

/** Codex details menu: refresh button, windows and usable reset cards. */
export const CodexDetails: Story = { play: openDetails }

/** Claude chip: calendar week plus the Fable weekly cap, shown as "week". */
export const ClaudeWeekly: Story = {
	decorators: withUsage(claudeUsageFixture),
}

/** Claude tooltip: "5 hour", "This week" and "Fable this week" with the reading age. */
export const ClaudeTooltip: Story = {
	decorators: withUsage(claudeUsageFixture),
	play: hoverChip,
}

/** Claude details menu with the refresh button. */
export const ClaudeDetails: Story = {
	decorators: withUsage(claudeUsageFixture),
	play: openDetails,
}

/** Claude with the Fable cap exhausted: the blocking window wins the chip. */
export const ClaudeFableExhausted: Story = {
	decorators: withUsage(claudeFableExhaustedUsageFixture),
}

/** Balance chip (DeepSeek): no plan and no windows, so the chip shows the balance. */
export const Balance: Story = {
	decorators: withUsage(balanceUsageFixture),
}

/** Balance tooltip: balance and today's token counts. */
export const BalanceTooltip: Story = {
	decorators: withUsage(balanceUsageFixture),
	play: hoverChip,
}

/** Balance details menu with the refresh button. */
export const BalanceDetails: Story = {
	decorators: withUsage(balanceUsageFixture),
	play: openDetails,
}
