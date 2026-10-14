import type { Meta, StoryObj } from "@storybook/react-vite"
import { userEvent, within } from "storybook/test"
import AutoApproveBar from "../auto-approve-menu/AutoApproveBar"
import { InputQueuePanel, type InputQueuePanelEntry } from "./InputQueuePanel"

/*
 * The bottom of the chat as ChatView stacks it: the auto-approve bar, the queue
 * toggle, then the composer. Opening the queue lays its list over the
 * auto-approve bar and the chat above it; nothing beneath may show through.
 */

const ENTRIES: InputQueuePanelEntry[] = [
    { id: "a", text: "Check whether the otel collector kept the crash exit logs", images: [], files: [], mode: "queued" },
    { id: "b", text: "Then summarise the restart timeline in the report", images: [], files: [], mode: "steering" },
    { id: "c", text: "Keep the existing dashboards untouched", images: [], files: [], mode: "queued" },
]

const noop = () => undefined

function ChatBottom() {
    return (
        <div className="flex h-[560px] w-[420px] flex-col bg-(--vscode-sideBar-background) text-(--vscode-foreground)">
            <div className="flex-1 overflow-hidden px-4 py-3 text-sm leading-6">
                {Array.from({ length: 12 }, (_, index) => (
                    <p className="m-0" key={index}>
                        Chat line {index + 1}: text that must stay hidden under the open queue list.
                    </p>
                ))}
            </div>
            <AutoApproveBar />
            <InputQueuePanel
                entries={ENTRIES}
                onCancelEdit={noop}
                onEdit={noop}
                onRemove={noop}
                onReorder={noop}
                onToggleMode={noop}
            />
            <div className="mx-3.5 mb-3 h-20 rounded border border-(--vscode-input-border,transparent) bg-(--vscode-input-background)" />
        </div>
    )
}

const meta: Meta<typeof ChatBottom> = {
    title: "Chat/Input Queue Overlay",
    component: ChatBottom,
    parameters: { layout: "padded" },
}

export default meta
type Story = StoryObj<typeof ChatBottom>

export const Collapsed: Story = {}

export const Open: Story = {
    play: async ({ canvasElement }) => {
        await userEvent.click(within(canvasElement).getByTestId("input-queue-toggle"))
    },
}
