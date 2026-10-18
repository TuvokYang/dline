import type { UiMessage } from "@shared/ExtensionMessage"
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react"
import { memo, useMemo } from "react"
import { TOOL_RESPONSE_SCROLL_CLASS } from "@/components/chat/constants"
import { ThinkingRow } from "@/components/chat/ThinkingRow"
import { cn } from "@/lib/utils"
import { isApiReqActive } from "@/utils/streaming"
import type { RowExpansionOrigin } from "../../types/chatTypes"
import { type ExplorationRound, type ExplorationRun, isToolGroup, type ToolMessageGroup } from "../../utils/chatRowKinds"
import { resolveMessageRowExpanded } from "../../utils/messageUtils"
import { CheckpointMarker } from "./CheckpointMarker"
import { buildToolsWithReasoning, getToolGroupSummaryFromParsedTools, ToolGroupRenderer } from "./ToolGroupRenderer"

interface ExplorationRunRendererProps {
    run: ExplorationRun
    allMessages: UiMessage[]
    /** The run is the newest row, so its last round may still be running. */
    isLastRow: boolean
    /** The run holds the newest tool group, which shows the calls still executing. */
    isLastActivity: boolean
    expandedRows: Record<number, boolean>
    onToggleExpand: (ts: number, origin?: RowExpansionOrigin) => void
}

/**
 * One row for consecutive read-only rounds.
 *
 * Collapsed, it reads like one tool group: the restore point taken before the
 * run, the summary, then every round's calls in order (click to open a file or
 * show search results). Only the thinking and the later restore points stay
 * folded. Expanded, it lists every round in order: that round's restore point,
 * its thinking (click to read it) and its tool calls.
 */
export const ExplorationRunRenderer = memo(
    ({ run, allMessages, isLastRow, isLastActivity, expandedRows, onToggleExpand }: ExplorationRunRendererProps) => {
        const [firstRound] = run._rounds
        const anchor = expansionAnchor(run)
        const isExpanded = resolveMessageRowExpanded(anchor, expandedRows)
        const isRunning = isLastRow && isApiReqActive(findLastRequest(allMessages))
        const summary = useMemo(() => summarizeRun(run), [run])
        const lastGroup = useMemo(() => findLastToolGroup(run._rounds), [run])
        const calls = useMemo(() => collectCalls(run._rounds), [run])
        const bodyId = `${run._explorationRunId}-rounds`

        return (
            <div data-testid="exploration-run">
                {firstRound?.checkpoint && (
                    <div className="px-4">
                        <CheckpointMarker message={firstRound.checkpoint} />
                    </div>
                )}
                <div className="px-4 pt-2 ml-1">
                    <button
                        aria-controls={bodyId}
                        aria-expanded={isExpanded}
                        className="flex w-full min-w-0 items-center gap-0.5 border-0 bg-transparent p-0 text-left text-[13px] font-semibold text-description cursor-pointer"
                        onClick={() => onToggleExpand(anchor.ts)}
                        type="button">
                        <span
                            className={cn("min-w-0 truncate", {
                                "animate-shimmer bg-linear-90 from-foreground to-description bg-[length:200%_100%] bg-clip-text text-transparent":
                                    isRunning,
                            })}>
                            {summary}
                        </span>
                        {isExpanded ? (
                            <ChevronDownIcon className="!size-3 shrink-0" />
                        ) : (
                            <ChevronRightIcon className="!size-3 shrink-0" />
                        )}
                    </button>
                </div>
                {!isExpanded && (
                    <ToolGroupRenderer
                        allMessages={allMessages}
                        isLastGroup={isLastActivity}
                        messages={calls}
                        showSummary={false}
                    />
                )}
                {isExpanded && (
                    <div className={TOOL_RESPONSE_SCROLL_CLASS} id={bodyId}>
                        {run._rounds.map((round, index) => (
                            <div data-testid="exploration-round" key={roundKey(round)}>
                                {/* The first restore point already heads the run. */}
                                {index > 0 && round.checkpoint && (
                                    <div className="px-4">
                                        <CheckpointMarker message={round.checkpoint} />
                                    </div>
                                )}
                                {round.entries.map((entry) =>
                                    isToolGroup(entry) ? (
                                        <ToolGroupRenderer
                                            allMessages={allMessages}
                                            isLastGroup={isLastActivity && entry === lastGroup}
                                            key={entry._toolGroupId}
                                            messages={entry}
                                            showSummary={false}
                                        />
                                    ) : (
                                        <div className="px-4 pt-1 ml-1" key={entry.ts}>
                                            <ThinkingRow
                                                isExpanded={resolveMessageRowExpanded(entry, expandedRows)}
                                                isStreaming={isRunning && entry.partial === true}
                                                isVisible={true}
                                                onToggle={() => onToggleExpand(entry.ts)}
                                                reasoningContent={entry.text}
                                                showChevron={Boolean(entry.text?.trim())}
                                                showTitle={true}
                                                title="Thinking"
                                            />
                                        </div>
                                    ),
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>
        )
    },
)

ExplorationRunRenderer.displayName = "ExplorationRunRenderer"

/**
 * The member whose expansion state stands for the whole run. Neither a round
 * checkpoint nor a grouped tool call keeps an expansion of its own, so using
 * one never collides with a reasoning row inside the run.
 */
function expansionAnchor(run: ExplorationRun): UiMessage {
    return run._rounds[0]?.checkpoint ?? run.find((message) => message.say === "tool" || message.ask === "tool") ?? run[0]
}

/** "Dline read 3 files, performed 1 search · 2 thoughts · 3 rounds" */
function summarizeRun(run: ExplorationRun): string {
    const tools = getToolGroupSummaryFromParsedTools(buildToolsWithReasoning(run).map((item) => item.parsedTool))
    const thoughts = run.filter((message) => message.say === "reasoning").length
    const rounds = run._rounds.length
    const parts = [tools]
    if (thoughts > 0) parts.push(`${thoughts} thought${thoughts === 1 ? "" : "s"}`)
    if (rounds > 1) parts.push(`${rounds} rounds`)
    return parts.join(" · ")
}

/** Every round's tool calls in order, without the thinking between them. */
function collectCalls(rounds: readonly ExplorationRound[]): UiMessage[] {
    const calls: UiMessage[] = []
    for (const round of rounds) {
        for (const entry of round.entries) {
            if (isToolGroup(entry)) calls.push(...entry)
        }
    }
    return calls
}

function findLastToolGroup(rounds: readonly ExplorationRound[]): ToolMessageGroup | undefined {
    for (let roundIndex = rounds.length - 1; roundIndex >= 0; roundIndex--) {
        const entries = rounds[roundIndex].entries
        for (let entryIndex = entries.length - 1; entryIndex >= 0; entryIndex--) {
            const entry = entries[entryIndex]
            if (isToolGroup(entry)) return entry
        }
    }
    return undefined
}

function findLastRequest(messages: readonly UiMessage[]): UiMessage | undefined {
    for (let index = messages.length - 1; index >= 0; index--) {
        if (messages[index].say === "api_req_started") return messages[index]
    }
    return undefined
}

function roundKey(round: ExplorationRound): number | string {
    if (round.checkpoint) return round.checkpoint.ts
    const [first] = round.entries
    return isToolGroup(first) ? first._toolGroupId : (first?.ts ?? "empty")
}
