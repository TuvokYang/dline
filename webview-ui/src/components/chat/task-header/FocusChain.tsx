import { cn } from "@heroui/react"
import { isCompletedFocusChainItem, isFocusChainItem } from "@shared/focus-chain-utils"
import { StringRequest } from "@shared/proto/dline/common"
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, XIcon } from "lucide-react"
import React, { memo, useCallback, useMemo, useState } from "react"
import ChecklistRenderer from "@/components/common/ChecklistRenderer"
import LightMarkdown from "@/components/common/LightMarkdown"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { FileServiceClient } from "@/services/grpc-client"

// Optimized interface with readonly properties to prevent accidental mutations
interface TodoInfo {
    readonly currentTodo: { text: string; completed: boolean; index: number } | null
    readonly currentIndex: number
    readonly completedCount: number
    readonly totalCount: number
    readonly progressPercentage: number
}

interface FocusChainProps {
    readonly lastProgressMessageText?: string
    readonly currentTaskItemId?: string
    readonly showPlaceholderWhenEmpty?: boolean
}

// Static strings to avoid recreating them
const COMPLETED_MESSAGE = "All tasks have been completed!"
const TODO_LIST_LABEL = "To-Do list"
const NEW_STEPS_MESSAGE = "New steps will be generated if you continue the task"
const _CLICK_TO_EDIT_TITLE = "Click to edit to-do list in file"

// Extract # Title from focus chain text (skip "Focus Chain List for Task" file header)
const extractMainTitle = (text: string): string | null => {
    const lines = text.split("\n")
    for (const line of lines) {
        const trimmed = line.trim()
        // Skip ## headings and the file header line
        if (trimmed.startsWith("## ") || !trimmed.startsWith("# ")) continue
        // Skip the auto-generated file header "Focus Chain List for Task"
        if (trimmed.includes("Focus Chain List for Task")) continue
        const title = trimmed.replace(/^#\s+/, "").trim()
        if (title) return title
    }
    return null
}

// Optimized header component with minimal re-renders
const ToDoListHeader = memo<{
    todoInfo: TodoInfo
    isExpanded: boolean
    mainTitle: string | null
}>(({ todoInfo, isExpanded, mainTitle }) => {
    const { currentTodo, currentIndex, totalCount, completedCount, progressPercentage } = todoInfo
    const isCompleted = completedCount === totalCount

    // Pre-compute display text
    const displayText = isCompleted ? COMPLETED_MESSAGE : currentTodo?.text || TODO_LIST_LABEL

    return (
        <div
            className={cn("relative w-full shrink-0", {
                "text-success": isCompleted,
            })}
            title={mainTitle || undefined}>
            <div
                className={cn(
                    "absolute bottom-0 left-0 transition-[width] duration-300 ease-in-out pointer-events-none z-1 h-1 bg-success",
                    {
                        "opacity-0": progressPercentage === 0 || progressPercentage === 100,
                    },
                )}
                style={{
                    width: `${progressPercentage}%`,
                }}
            />
            <div className="flex items-center gap-2 z-10 py-2 px-2.5">
                <div className="flex items-center gap-1.5 flex-1 min-w-0 text-sm">
                    <span
                        className={cn(
                            "rounded-lg px-2 py-0.25 inline-block shrink-0 bg-badge-foreground/20 text-foreground text-sm",
                            {
                                "bg-success text-black": isCompleted,
                            },
                        )}>
                        {completedCount}/{totalCount}
                    </span>
                    <div className="header-text flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-sm font-medium">
                        <LightMarkdown compact text={displayText} />
                    </div>
                </div>
                <div className="flex items-center text-foreground shrink-0">
                    {isExpanded ? <ChevronDownIcon className="ml-0.25" size="16" /> : <ChevronRightIcon size="16" />}
                </div>
            </div>
        </div>
    )
})

ToDoListHeader.displayName = "ToDoListHeader"

// Cache for parsed todo info to avoid re-parsing identical text
const todoInfoCache = new Map<string, TodoInfo | null>()
const MAX_CACHE_SIZE = 100

// Highly optimized parsing with minimal allocations
const parseCurrentTodoInfo = (text: string): TodoInfo | null => {
    if (!text) {
        return null
    }

    // Check cache first
    const cached = todoInfoCache.get(text)
    if (cached !== undefined) {
        return cached
    }

    let completedCount = 0
    let totalCount = 0
    let firstIncompleteIndex = -1
    let firstIncompleteText: string | null = null

    // Process text line by line without creating intermediate arrays
    let lineStart = 0
    let lineEnd = text.indexOf("\n")

    while (lineStart < text.length) {
        const line = lineEnd === -1 ? text.substring(lineStart).trim() : text.substring(lineStart, lineEnd).trim()

        if (isFocusChainItem(line)) {
            const isCompleted = isCompletedFocusChainItem(line)

            if (isCompleted) {
                completedCount++
            } else if (firstIncompleteIndex === -1) {
                firstIncompleteIndex = totalCount
                // Extract text only for the first incomplete item
                firstIncompleteText = line.substring(5).trim()
            }

            totalCount++
        }

        if (lineEnd === -1) {
            break
        }
        lineStart = lineEnd + 1
        lineEnd = text.indexOf("\n", lineStart)
    }

    if (totalCount === 0) {
        todoInfoCache.set(text, null)
        return null
    }

    const currentTodo = firstIncompleteText ? { text: firstIncompleteText, completed: false, index: firstIncompleteIndex } : null

    const result: TodoInfo = {
        currentTodo,
        currentIndex: firstIncompleteIndex >= 0 ? firstIncompleteIndex + 1 : totalCount,
        completedCount,
        totalCount,
        progressPercentage: (completedCount / totalCount) * 100,
    }

    // Cache the result with size management
    if (todoInfoCache.size >= MAX_CACHE_SIZE) {
        // Remove oldest entry (first key)
        const firstKey = todoInfoCache.keys().next().value
        if (firstKey) {
            todoInfoCache.delete(firstKey)
        }
    }
    todoInfoCache.set(text, result)
    return result
}

// History entry with timestamp, main title and sections
interface HistorySection {
    title: string | null
    items: string[]
}

interface HistoryEntry {
    timestamp: string
    mainTitle: string | null
    sections: HistorySection[]
}

// Parse history content into entries grouped by ## Completed — date markers
const parseHistoryContent = (historyText: string): { entries: HistoryEntry[] } => {
    const entries: HistoryEntry[] = []
    const lines = historyText.split("\n")
    let currentEntry: HistoryEntry | null = null
    let currentSectionTitle: string | null = null
    let currentSectionItems: string[] = []

    const flushSection = () => {
        if (currentEntry && currentSectionItems.length > 0) {
            currentEntry.sections.push({ title: currentSectionTitle, items: [...currentSectionItems] })
        }
    }

    const flushEntry = () => {
        flushSection()
        if (currentEntry) {
            entries.push(currentEntry)
            currentEntry = null
        }
        currentSectionTitle = null
        currentSectionItems = []
    }

    for (const line of lines) {
        const trimmed = line.trim()
        // ## Completed — date: start new entry
        if (trimmed.startsWith("## Completed")) {
            flushEntry()
            currentEntry = { timestamp: trimmed.replace(/^##\s+/, ""), mainTitle: null, sections: [] }
            continue
        }
        if (!currentEntry) continue // skip lines before first entry

        // # Title (skip file header)
        if (trimmed.startsWith("# ") && !trimmed.startsWith("## ") && !trimmed.includes("Focus Chain List")) {
            if (!currentEntry.mainTitle) {
                currentEntry.mainTitle = trimmed.replace(/^#\s+/, "")
            }
            continue
        }
        // ## Section
        if (trimmed.startsWith("## ")) {
            flushSection()
            currentSectionTitle = trimmed.replace(/^##\s+/, "")
            currentSectionItems = []
            continue
        }
        if (isFocusChainItem(trimmed)) {
            currentSectionItems.push(trimmed)
        }
    }

    flushEntry()
    return { entries }
}

// Main component with aggressive optimization
export const FocusChain: React.FC<FocusChainProps> = memo(
    ({ currentTaskItemId, lastProgressMessageText, showPlaceholderWhenEmpty }) => {
        const [isExpanded, setIsExpanded] = useState(false)
        const { focusChainHistory } = useExtensionState()

        // Parse todo info with caching
        const todoInfo = useMemo(
            () => (lastProgressMessageText ? parseCurrentTodoInfo(lastProgressMessageText) : null),
            [lastProgressMessageText],
        )

        // Parse history content
        const historyEntries = useMemo(
            () => (focusChainHistory ? parseHistoryContent(focusChainHistory).entries : []),
            [focusChainHistory],
        )

        // Static callbacks that don't change
        const handleToggle = useCallback(() => setIsExpanded((prev) => !prev), [])

        const handleEditClick = useCallback(
            (e: React.MouseEvent) => {
                e.preventDefault()
                e.stopPropagation()
                if (currentTaskItemId) {
                    FileServiceClient.openFocusChainFile(StringRequest.create({ value: currentTaskItemId }))
                }
            },
            [currentTaskItemId],
        )

        // Extract # Title for tooltip display
        const mainTitle = useMemo(
            () => (lastProgressMessageText ? extractMainTitle(lastProgressMessageText) : null),
            [lastProgressMessageText],
        )

        // Early return for no content
        if (!todoInfo) {
            if (!showPlaceholderWhenEmpty) {
                return null
            }

            return (
                <div
                    aria-hidden={true}
                    className="relative rounded-sm bg-toolbar-hover/65 flex items-center gap-2 select-none overflow-hidden opacity-80 px-2.5 py-2">
                    <span className="rounded-lg px-2 py-0.25 inline-block shrink-0 bg-badge-foreground/20 text-foreground text-sm">
                        0/0
                    </span>
                    <span className="text-sm text-foreground/80 truncate">TODOs</span>
                </div>
            )
        }

        if (isExpanded && !lastProgressMessageText) {
            return null
        }

        const isCompleted = todoInfo.completedCount === todoInfo.totalCount
        const hasHistory = historyEntries.length > 0

        return (
            <div
                aria-label={isExpanded ? "Collapse focus chain" : "Expand focus chain"}
                className="relative rounded-sm bg-toolbar-hover/65 flex flex-col gap-1.5 select-none hover:bg-toolbar-hover overflow-hidden opacity-80 hover:opacity-100 transition-[transform,box-shadow] duration-200 cursor-pointer"
                onClick={handleToggle}
                onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault()
                        e.stopPropagation()
                        handleToggle()
                    }
                }}>
                <ToDoListHeader isExpanded={isExpanded} mainTitle={mainTitle} todoInfo={todoInfo} />
                {isExpanded && (
                    <div
                        className="focus-chain-scrollable scrollable mx-1 max-h-[40vh] overflow-y-auto pb-2 px-1 relative"
                        data-testid="focus-chain-expanded-content"
                        onClick={handleEditClick}>
                        {/* Main Title */}
                        {mainTitle && <div className="text-xs font-bold text-foreground/80 mb-1.5">{mainTitle}</div>}
                        {/* Active Tasks Section */}
                        <div className="mb-2">
                            <ChecklistRenderer text={lastProgressMessageText!} />
                            {isCompleted && (
                                <div className="mt-2 text-xs font-semibold text-muted-foreground">{NEW_STEPS_MESSAGE}</div>
                            )}
                        </div>

                        {/* Completed History Section */}
                        {hasHistory && (
                            <div className="border-t border-border/50 pt-2 mt-2">
                                <div className="flex flex-col gap-2" data-testid="focus-chain-history">
                                    {historyEntries.map((entry, entryIdx) => (
                                        <div className={entryIdx > 0 ? "border-t border-border/20 pt-2" : ""} key={entryIdx}>
                                            <div className="text-[10px] font-semibold text-muted-foreground/50 mb-1">
                                                {entry.timestamp}
                                            </div>
                                            {entry.mainTitle && (
                                                <div className="text-xs font-semibold text-foreground/60 mb-1">
                                                    {entry.mainTitle}
                                                </div>
                                            )}
                                            <div className="opacity-75">
                                                {entry.sections.map((section, sectionIdx) => (
                                                    <div className="mb-1 last:mb-0" key={sectionIdx}>
                                                        {section.title && (
                                                            <div className="text-[10px] font-medium text-muted-foreground/70 mb-0.5">
                                                                {section.title}
                                                            </div>
                                                        )}
                                                        {section.items.map((item, itemIdx) => {
                                                            const isCompleted =
                                                                item.startsWith("- [x]") || item.startsWith("- [X]")
                                                            return (
                                                                <div className="flex items-center gap-1 pl-1" key={itemIdx}>
                                                                    {isCompleted ? (
                                                                        <CheckIcon className="shrink-0 text-success" size={8} />
                                                                    ) : (
                                                                        <XIcon className="shrink-0 text-error" size={8} />
                                                                    )}
                                                                    <span className="text-[11px] text-muted-foreground">
                                                                        {item.replace(/^-\s*\[[xX ]\]\s*/, "")}
                                                                    </span>
                                                                </div>
                                                            )
                                                        })}
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </div>
        )
    },
    (prevProps, nextProps) => {
        // Custom comparison for better performance
        return (
            prevProps.lastProgressMessageText === nextProps.lastProgressMessageText &&
            prevProps.currentTaskItemId === nextProps.currentTaskItemId &&
            prevProps.showPlaceholderWhenEmpty === nextProps.showPlaceholderWhenEmpty
        )
    },
)

FocusChain.displayName = "FocusChain"
