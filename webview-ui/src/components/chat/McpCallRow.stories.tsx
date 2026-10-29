import type { UiMessage } from "@shared/ExtensionMessage"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { type ReactNode, useMemo, useState } from "react"
import { ExtensionStateContext, useExtensionState } from "@/context/ExtensionStateContext"
import { ChatRowContent } from "./ChatRow"

/*
 * An MCP call row through its life: the card stays open while the call is
 * pending or running, and once its response has landed the call is final and
 * folds to its header, request and response together. The header reopens it.
 * Inside the card the tool name is a fixed title that folds the description and
 * arguments on its own; the description is long enough to make that area scroll.
 */

const SERVER = "otel"
const TOOL = "query_loki_logs"
const DESCRIPTION = [
    "Executes a log query against a Loki or VictoriaLogs datasource and returns matching log entries (or metric samples on Loki).",
    "Defaults to the last hour, a limit of 10 entries, and 'backward' direction (newest first).",
    'The logql parameter takes a full LogQL expression: a stream selector such as {service_name="api"} followed by any number of line filters (|=, !=, |~, !~), parsers (| json, | logfmt, | pattern, | regexp) and label filters on the extracted fields.',
    'Metric queries such as rate({job="api"} |= "error" [5m]) or sum by (level) (count_over_time({app="web"}[1m])) return samples instead of log lines and are only supported on Loki.',
    "Use startRfc3339 and endRfc3339 to bound the time range explicitly; relative ranges are resolved on the server at the time of the request.",
    "The limit applies to log lines, not to streams, so a query that matches many streams may still return fewer lines per stream than expected.",
    "Prefer narrow stream selectors: a selector that matches every stream forces the datasource to scan all chunks in the range and can time out on large clusters.",
    "Use list_loki_label_names and list_loki_label_values first to discover which labels exist, and query_loki_stats to estimate how much data a selector covers before running an expensive query.",
    "Results are returned newest first unless direction is set to 'forward'. Each entry carries its timestamp, the raw line and the stream labels it came from.",
].join(" ")

function callMessage(ts: number): UiMessage {
    return {
        ts,
        type: "say",
        say: "use_mcp_server",
        text: JSON.stringify({
            type: "use_mcp_tool",
            serverName: SERVER,
            toolName: TOOL,
            arguments: JSON.stringify({ datasourceUid: "loki", logql: '{service_name="dline"} |= "error"', limit: 10 }),
        }),
    }
}

function responseMessage(ts: number, requestTs: number): UiMessage {
    return {
        ts,
        type: "say",
        say: "mcp_server_response",
        text: JSON.stringify({
            type: "mcp_server_response",
            requestTs,
            responses: [
                JSON.stringify(
                    [
                        {
                            timestamp: "2026-10-14T04:37:48Z",
                            line: "extension host exited unexpectedly",
                            labels: { level: "error" },
                        },
                    ],
                    null,
                    2,
                ),
            ],
        }),
    }
}

const PENDING_CALL = callMessage(1000)
const FINAL_CALL = callMessage(2000)
const MESSAGES = [PENDING_CALL, FINAL_CALL, responseMessage(2001, 2000)]

/** One row with its own expansion state, as the chat list owns it. */
function Row({
    message,
    isLast,
    initiallyExpanded = false,
}: {
    message: UiMessage
    isLast: boolean
    initiallyExpanded?: boolean
}) {
    const [expanded, setExpanded] = useState(initiallyExpanded)
    return (
        <ChatRowContent
            isExpanded={expanded}
            isLast={isLast}
            message={message}
            onSetQuote={() => undefined}
            onToggleExpand={() => setExpanded((value) => !value)}
        />
    )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
    return (
        <section className="flex flex-col gap-3">
            <h3 className="m-0 text-[11px] font-semibold uppercase tracking-wide text-description">{title}</h3>
            {children}
        </section>
    )
}

function Gallery() {
    const base = useExtensionState()
    const context = useMemo(
        () => ({
            ...base,
            clineMessages: MESSAGES,
            mcpServers: [
                {
                    name: SERVER,
                    config: "{}",
                    status: "connected" as const,
                    tools: [{ name: TOOL, description: DESCRIPTION, autoApprove: true }],
                },
            ],
        }),
        [base],
    )
    return (
        <ExtensionStateContext.Provider value={context}>
            <div className="flex flex-col gap-8">
                <Section title="Running (no response yet): card open">
                    <Row isLast={false} message={PENDING_CALL} />
                </Section>
                <Section title="Final (response landed): folded, click the header to open">
                    <Row isLast={false} message={FINAL_CALL} />
                </Section>
                <Section title="Final, opened: the details keep 30vh and scroll; click the tool name to fold them">
                    <Row initiallyExpanded isLast={false} message={FINAL_CALL} />
                </Section>
            </div>
        </ExtensionStateContext.Provider>
    )
}

const meta: Meta<typeof Gallery> = {
    title: "Chat/MCP Call Row",
    component: Gallery,
    parameters: { layout: "padded" },
    decorators: [
        (Story) => (
            <div className="w-full max-w-[720px] bg-(--vscode-sideBar-background) p-4 text-(--vscode-foreground)">
                <Story />
            </div>
        ),
    ],
}

export default meta
type Story = StoryObj<typeof Gallery>

export const RunningAndFinal: Story = {}
