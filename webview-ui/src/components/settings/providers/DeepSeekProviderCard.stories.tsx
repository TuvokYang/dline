import type { AccountUsageData } from "@shared/ExtensionMessage"
import { ApiFormat } from "@shared/proto/dline/models/metadata"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, within } from "storybook/test"
import { createStorybookDecorator } from "@/config/StorybookDecorator"
import { DEEPSEEK_STORY_PRICING } from "./DeepSeekOffPeakPricing.stories"
import { type DeepSeekEffort, DeepSeekProviderCard, type DeepSeekProviderCardProps } from "./DeepSeekProviderCard"
import { balanceUsageFixture } from "./usageStoryFixtures"

const MODELS = ["deepseek-flash", "deepseek-v4-pro"] as const

type CardProps = Partial<Omit<DeepSeekProviderCardProps, "profileId" | "models">>

function CardFixture({
    apiFormat = ApiFormat.OPENAI_CHAT,
    enableThinking = false,
    effort,
    modelId = "deepseek-v4-pro",
    pricing = DEEPSEEK_STORY_PRICING,
}: CardProps) {
    return (
        <div className="flex w-[400px] flex-col rounded-xs border border-editor-widget-border p-3">
            <span className="mb-2 text-sm font-medium text-foreground">DeepSeek</span>
            <DeepSeekProviderCard
                apiFormat={apiFormat}
                apiKey="sk-storybook0000000000000000"
                effort={effort}
                enableThinking={enableThinking}
                modelId={modelId}
                models={MODELS}
                onApiFormatChange={() => undefined}
                onApiKeyChange={() => undefined}
                onEffortChange={() => undefined}
                onEnableThinkingChange={() => undefined}
                onModelChange={() => undefined}
                pricing={pricing}
                profileId="profile-story"
            />
        </div>
    )
}

const withUsage = (accountUsage: AccountUsageData = balanceUsageFixture) => [createStorybookDecorator({ accountUsage }, "p-6")]

const meta = {
    title: "Settings/Providers/DeepSeekProviderCard",
    component: CardFixture,
    parameters: { layout: "fullscreen" },
    decorators: withUsage(),
} satisfies Meta<typeof CardFixture>

export default meta
type Story = StoryObj<typeof meta>

/** Protocol and thinking controls share the same declared rates. */
export const DeepSeekDirect: Story = {}
export const ResponsesProtocol: Story = { args: { apiFormat: ApiFormat.OPENAI_RESPONSES } }

/**
 * Thinking is a Profile choice, not something the model id implies.
 *
 * With the checkbox off the card must show no level selector at all, matching
 * `DeepSeekProvider`: the stored preference is off, so there is nothing to pick.
 */
export const ThinkingDisabled: Story = {
    args: { enableThinking: false },
    decorators: withUsage({ ...balanceUsageFixture, remainingBalance: 7.4 }),
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement)
        await expect(canvas.getByRole("checkbox", { name: "Enable Thinking" })).not.toBeChecked()
        await expect(canvas.queryByText("Thinking Level")).toBeNull()
    },
}

/**
 * Thinking enabled with a stored level: the checkbox is on and exactly that
 * level is selected, because the Profile round-tripped a real preference.
 */
export const ThinkingEnabled: Story = {
    args: { enableThinking: true, effort: "high" satisfies DeepSeekEffort },
    decorators: withUsage({ ...balanceUsageFixture, remainingBalance: 7.4 }),
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement)
        await expect(canvas.getByRole("checkbox", { name: "Enable Thinking" })).toBeChecked()
        await expect(canvas.getByText("Thinking Level")).toBeVisible()
        await expect(canvas.getByText("High")).toBeVisible()
    },
}
