import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"
import { ThinkingRow } from "./ThinkingRow"

function ReadingFixture() {
    const [parts, setParts] = useState(12)
    const [streaming, setStreaming] = useState(true)
    const [expanded, setExpanded] = useState(true)
    const [narrow, setNarrow] = useState(false)
    const content = Array.from(
        { length: parts },
        (_, index) =>
            `**Step ${index + 1}**\n\nInspect the request boundary and preserve the \`summary_index\` before converting the next streamed event.`,
    ).join("\n\n")
    return (
        <div className="p-4">
            <div className="flex gap-3 mb-4">
                <button onClick={() => setParts((count) => count + 1)} type="button">
                    Append chunk
                </button>
                <button onClick={() => setStreaming((value) => !value)} type="button">
                    {streaming ? "Stop stream" : "Resume stream"}
                </button>
                <button onClick={() => setNarrow((value) => !value)} type="button">
                    Toggle width
                </button>
                <span role="status">Parts: {parts}</span>
            </div>
            <div style={{ width: narrow ? 220 : 420 }}>
                <ThinkingRow
                    isExpanded={expanded}
                    isStreaming={streaming}
                    isVisible={true}
                    onToggle={() => setExpanded((value) => !value)}
                    reasoningContent={content}
                    showTitle={true}
                    title={streaming ? "Thinking..." : "Thinking"}
                />
            </div>
        </div>
    )
}

const meta = {
    title: "Chat/Thinking Row",
    component: ReadingFixture,
    parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ReadingFixture>

export default meta
type Story = StoryObj<typeof meta>

/** Real-layout fixture for stream following, manual reading, stopping and reopening. */
export const Reading: Story = {}
