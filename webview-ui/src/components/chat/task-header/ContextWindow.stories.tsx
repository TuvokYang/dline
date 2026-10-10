import type { ContextWindowIndicatorSnapshot } from "@shared/context-window-indicator"
import type { Meta, StoryObj } from "@storybook/react-vite"
import ContextWindow from "./ContextWindow"

const snapshot: ContextWindowIndicatorSnapshot = {
    taskId: "context-window-story",
    revision: 1,
    epoch: 1,
    phase: "sending",
    durableContextTokens: 178_800,
    pendingSendTokens: 5_500,
    receivingTokens: 0,
    stagedTokens: 0,
    environmentTokens: 1_000,
    contextWindow: 472_000,
    mode: "act",
    updatedAt: 1,
    lineage: { kind: "baseline" },
}

function ContextWindowFixture() {
    return (
        <div className="flex h-[520px] w-[520px] items-center p-8" data-testid="context-window-fixture">
            <ContextWindow contextWindowIndicator={snapshot} useAutoCondense={false} />
        </div>
    )
}

const meta = {
    title: "Chat/ContextWindow",
    component: ContextWindowFixture,
    parameters: {
        layout: "centered",
    },
} satisfies Meta<typeof ContextWindowFixture>

export default meta
type Story = StoryObj<typeof meta>

export const SegmentedSummary: Story = {}
