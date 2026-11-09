import { DlineDefaultTool as Tool } from "@shared/tools"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { PREVIEW_TOOLS, SubagentCapabilitiesPreview } from "./storybook/SubagentCapabilitiesPreview"
import { SubagentRowStoryFixture } from "./storybook/SubagentRowStoryFixture"

const meta = {
    title: "Capabilities/Subagent Selection Preview",
    component: SubagentCapabilitiesPreview,
    parameters: {
        layout: "fullscreen",
        docs: {
            description: {
                component:
                    "Interactive design proposal only. Example inventories and all choices stay in memory; no RPC, file save or runtime filtering is connected.",
            },
        },
    },
} satisfies Meta<typeof SubagentCapabilitiesPreview>

export default meta
type Story = StoryObj<typeof meta>

export const Selection: Story = {
    name: "1 · Skills and workflows",
    args: { initialTab: "skills", initialTools: PREVIEW_TOOLS },
}

export const Rules: Story = {
    name: "6 · Rules injected into system prompt",
    args: { initialTab: "rules", initialTools: [] },
}

export const MissingLoaders: Story = {
    name: "2 · Missing loader tools",
    args: { initialTab: "skills", initialTools: [Tool.FILE_READ, Tool.SEARCH] },
}

export const McpSelection: Story = {
    name: "3 · MCP tools and resources",
    args: { initialTab: "mcp", initialTools: [Tool.FILE_READ, Tool.SEARCH, Tool.MCP_ACCESS] },
}

export const EmptyCatalog: Story = {
    name: "4 · No available capabilities",
    args: { initialTab: "skills", emptyCatalog: true },
}

export const Narrow: Story = {
    name: "5 · Narrow sidebar",
    args: { initialTab: "mcp" },
    decorators: [
        (Story) => (
            <div style={{ maxWidth: 380 }}>
                <Story />
            </div>
        ),
    ],
}

// Real production SubagentRow against an in-memory RPC mock. The other six
// stories are design previews only; this one exercises the shipped editor.
export const ProductionEditor: Story = {
    render: () => <SubagentRowStoryFixture />,
}
