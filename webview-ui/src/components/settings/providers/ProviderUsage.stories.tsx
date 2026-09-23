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

/** Balance account (DeepSeek): balance summary plus today's token counts. */
export const Balance: Story = {
	args: { title: "DeepSeek" },
	decorators: withUsage(balanceUsageFixture),
	play: expandCard,
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
