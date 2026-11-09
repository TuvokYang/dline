import type { AccountUsageData } from "@shared/ExtensionMessage"
import { ApiFormat, type ModelCapabilities } from "@shared/proto/dline/models/metadata"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, userEvent, within } from "storybook/test"
import { createStorybookDecorator } from "@/config/StorybookDecorator"
import { type OpenCodePlan, OpenCodeProviderCard } from "./OpenCodeProviderCard"
import {
    openCodeBalanceUsageFixture,
    openCodeGoPlusUsageFixture,
    openCodeGoTeamsUsageFixture,
    openCodeGoUsageFixture,
    openCodeNoDataUsageFixture,
} from "./usageStoryFixtures"

/**
 * Models the gateway publishes across both of its base URLs.
 *
 * Only the identifiers matter here: the card renders whatever the registry
 * returns, and these stories exist to review the layout and the plan/format
 * interaction rather than the catalog itself.
 */
const MODELS = ["claude-sonnet-5-5", "gpt-6-sol", "glm-5.3", "kimi-k3", "gemini-4-argon"] as const

/**
 * The reasoning shapes the gateway resells.
 *
 * They are the point of this fixture: the card has to render graded effort, a
 * token budget, or nothing, purely from what the selected model declares.
 */
const EFFORT_CAPABILITIES: ModelCapabilities = {
    supportsReasoning: true,
    thinking: { supported: true, mode: "effort", effortLevels: ["none", "low", "medium", "high", "max"], defaultEffort: "high" },
}

const BUDGET_CAPABILITIES: ModelCapabilities = {
    supportsReasoning: true,
    thinking: { supported: true, mode: "budget", minBudget: 1_024, maxBudget: 8_192 },
}

/** A model the gateway resells that declares no reasoning at all. */
const NO_REASONING_CAPABILITIES: ModelCapabilities = { supportsTools: true }

interface CardFixtureProps {
    readonly plan: OpenCodePlan
    readonly usage: AccountUsageData
    readonly apiFormat?: ApiFormat
    readonly capabilities?: ModelCapabilities
    readonly enableThinking?: boolean
    readonly effort?: string
    readonly nativeApiFormat?: ApiFormat
    readonly modelId?: string
}

/**
 * The card framed like the Provider section it sits in.
 *
 * `ProviderUsage` renders the snapshot the backend publishes, which Storybook
 * has no backend for, so each story supplies the matching usage fixture.
 */
function CardFixture({
    apiFormat,
    capabilities,
    enableThinking,
    effort,
    modelId = "claude-sonnet-5-5",
    nativeApiFormat,
    plan,
}: CardFixtureProps) {
    return (
        <div className="flex w-[380px] flex-col rounded-xs border border-editor-widget-border p-3">
            <span className="mb-2 text-sm font-medium text-foreground">OpenCode</span>
            <OpenCodeProviderCard
                apiFormat={apiFormat ?? ApiFormat.ANTHROPIC_CHAT}
                apiKey="oc_sk_storybook0000000000000000"
                capabilities={capabilities}
                effort={effort}
                enableThinking={enableThinking}
                modelId={modelId}
                models={MODELS}
                nativeApiFormat={nativeApiFormat}
                onApiFormatChange={() => undefined}
                onApiKeyChange={() => undefined}
                onModelChange={() => undefined}
                onPlanChange={() => undefined}
                plan={plan}
                profileId="profile-story"
            />
        </div>
    )
}

const withUsage = (usage: AccountUsageData) => [createStorybookDecorator({ accountUsage: usage }, "p-6")]

/** Expand the usage card so a review sees the rows, not only the summary line. */
const expandUsage: Story["play"] = async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const toggle = canvas.getByRole("button", { name: /^Usage / })
    await userEvent.click(toggle)
    await expect(toggle).toHaveAttribute("aria-expanded", "true")
}

/** The card must never present a base URL, because the Plan picker owns it. */
const assertNoBaseUrl = async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.queryByLabelText("Base URL")).toBeNull()
}

const meta = {
    title: "Settings/Providers/OpenCodeProviderCard",
    component: CardFixture,
    parameters: { layout: "fullscreen" },
} satisfies Meta<typeof CardFixture>

export default meta
type Story = StoryObj<typeof meta>

/**
 * Pay-as-you-go: the plan changes how usage is reported, and the card offers
 * all three protocols because the gateway serves every paid model through each
 * of them.
 */
export const PayAsYouGo: Story = {
    args: { capabilities: EFFORT_CAPABILITIES, plan: "balance", usage: openCodeBalanceUsageFixture },
    decorators: withUsage(openCodeBalanceUsageFixture),
    play: async (context) => {
        await assertNoBaseUrl(context)
        await expandUsage(context)
    },
}

/**
 * A model that declares graded effort: the card offers the checkbox plus a
 * `Thinking Level` limited to the levels that model publishes.
 */
export const EffortModel: Story = {
    args: {
        capabilities: EFFORT_CAPABILITIES,
        effort: "high",
        enableThinking: true,
        plan: "go",
        usage: openCodeGoUsageFixture,
    },
    decorators: withUsage(openCodeGoUsageFixture),
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement)
        await expect(canvas.getByRole("checkbox", { name: "Enable Thinking" })).toBeChecked()
        await expect(canvas.getByText("Thinking Level")).toBeVisible()
        await expect(canvas.getByText("High")).toBeVisible()
    },
}

/**
 * A model that declares a token budget instead of effort. The card must not
 * show `Thinking Level` here: that vocabulary belongs to the effort shape.
 */
export const BudgetModel: Story = {
    args: { capabilities: BUDGET_CAPABILITIES, enableThinking: true, plan: "go", usage: openCodeGoUsageFixture },
    decorators: withUsage(openCodeGoUsageFixture),
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement)
        await expect(canvas.getByLabelText("Thinking Budget")).toBeVisible()
        await expect(canvas.queryByText("Thinking Level")).toBeNull()
    },
}

/**
 * A resold model that declares no reasoning. Offering any thinking control here
 * would let the Profile store a preference the gateway cannot honour.
 */
export const NoReasoningModel: Story = {
    args: { capabilities: NO_REASONING_CAPABILITIES, plan: "go", usage: openCodeGoUsageFixture },
    decorators: withUsage(openCodeGoUsageFixture),
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement)
        await expect(canvas.queryByRole("checkbox", { name: "Enable Thinking" })).toBeNull()
        await expect(canvas.queryByText("Thinking Level")).toBeNull()
    },
}

/** OpenCode Go ($10/month): three usage windows against the Go limit table. */
export const Go: Story = {
    args: { plan: "go", usage: openCodeGoUsageFixture },
    decorators: withUsage(openCodeGoUsageFixture),
    play: async (context) => {
        await assertNoBaseUrl(context)
        await expandUsage(context)
    },
}

/**
 * Go Plus ($40/month). Apart from the picker this renders like `Go`, which is
 * the intended distinction: the plan is a declared fact, and the numbers change
 * because the usage fixture carries a higher limit.
 */
export const GoPlus: Story = {
    args: { plan: "go-plus", usage: openCodeGoPlusUsageFixture },
    decorators: withUsage(openCodeGoPlusUsageFixture),
    play: async (context) => {
        await assertNoBaseUrl(context)
        await expandUsage(context)
    },
}

/**
 * Go Teams ($20/member/month). Its per-model limits are a third table, so the
 * usage windows must differ from both `Go` and `Go Plus` even though the
 * gateway reports this account's billing source as a plain Go plan.
 */
export const GoTeams: Story = {
    args: { plan: "go-teams", usage: openCodeGoTeamsUsageFixture },
    decorators: withUsage(openCodeGoTeamsUsageFixture),
    play: async (context) => {
        await assertNoBaseUrl(context)
        await expandUsage(context)
    },
}

/**
 * Before the first response reports a cost: the usage card says so instead of
 * drawing an empty window that would read as an untouched allowance.
 */
export const BeforeFirstRequest: Story = {
    args: { plan: "go", usage: openCodeNoDataUsageFixture },
    decorators: withUsage(openCodeNoDataUsageFixture),
    play: async (context) => {
        await assertNoBaseUrl(context)
        const canvas = within(context.canvasElement)
        await expect(canvas.getByRole("button", { name: /^Usage / })).toBeDisabled()
    },
}

/**
 * A model the gateway publishes through Anthropic Messages while the Profile
 * requests OpenAI Chat. The card states that the gateway translates the
 * request; it does not block the choice.
 */
export const TranslatedProtocol: Story = {
    args: {
        apiFormat: ApiFormat.OPENAI_CHAT,
        modelId: "claude-sonnet-5-5",
        nativeApiFormat: ApiFormat.ANTHROPIC_CHAT,
        plan: "go",
        usage: openCodeGoUsageFixture,
    },
    decorators: withUsage(openCodeGoUsageFixture),
    play: async (context) => {
        const canvas = within(context.canvasElement)
        await expect(canvas.getByText(/Console translates this protocol/)).toBeVisible()
    },
}
