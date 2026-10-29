import { StringRequest } from "@shared/proto/dline/common"
import { FilePlus, FileText, FileX, SquareArrowOutUpRightIcon } from "lucide-react"
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import CodeAccordian from "@/components/common/CodeAccordian"
import { cn } from "@/lib/utils"
import { FileServiceClient } from "@/services/grpc-client"
import { TOOL_RESPONSE_SCROLL_CLASS } from "./constants"

interface Patch {
    action: string
    path: string
    lines: string[]
    additions: number
    deletions: number
}

const MARKERS = {
    NEW_BEGIN: "*** Begin Patch",
    NEW_END: "*** End Patch",
    FILE_PATTERN: /^\*\*\* (Add|Update|Delete) File: (.+)$/m,
} as const

const ACTION_STYLES = {
    Add: { icon: FilePlus, iconClass: "text-success", borderClass: "border-l-success" },
    Delete: { icon: FileX, iconClass: "text-error", borderClass: "border-l-error" },
    default: { icon: FileText, iconClass: "text-info", borderClass: "border-l-background" },
} as const

interface DiffEditRowProps {
    patch: string | string[]
    path: string
    isLoading?: boolean
    startLineNumbers?: number[]
    /** Per-block error messages, same index as startLineNumbers */
    blockErrors?: (string | undefined)[]
    /** Action type for icon: "Add" → FilePlus, "Update" → FileText */
    fileAction?: "Add" | "Update"
}

export const DiffEditRow = memo<DiffEditRowProps>(({ patch, path, isLoading, startLineNumbers, blockErrors, fileAction }) => {
    const { parsedFiles, isStreaming } = useMemo(() => {
        const parsed = parsePatch(patch, path, fileAction)
        return { parsedFiles: parsed.parsedFiles, isStreaming: isLoading || parsed.isStreaming }
    }, [patch, path, isLoading, fileAction])

    if (!path) return null

    return (
        <div className={`space-y-4 rounded-xs pr-1 ${TOOL_RESPONSE_SCROLL_CLASS}`} data-testid="diff-edit-scroll">
            {parsedFiles.map((file, index) => (
                <FileBlock
                    blockError={blockErrors?.[index]}
                    file={file}
                    isPartial={isLoading}
                    isStreaming={isStreaming}
                    key={`${file.path}-${index}`}
                    startLineNumber={startLineNumbers?.[index]}
                />
            ))}
        </div>
    )
})

/**
 * Renders a file diff block that encountered an error (e.g. SEARCH block not matched).
 * Kept as a separate component so that useState hooks remain top-level per React rules.
 */
const FileBlock = memo<{
    file: Patch
    isStreaming: boolean
    isPartial?: boolean
    startLineNumber?: number
    /** Per-block error message rendered at the bottom of the file block */
    blockError?: string
}>(
    ({ file, isStreaming, isPartial, startLineNumber, blockError }) => {
        const hasError = !!blockError
        const [isExpanded, setIsExpanded] = useState(!!isPartial)
        const scrollContainerRef = useRef<HTMLDivElement>(null)
        const shouldFollowRef = useRef(true)
        const isProgrammaticScrollRef = useRef(false)
        // Once the user has decided, no stream update may override the choice.
        // Auto-expansion previously reasserted itself on every partial frame and
        // fought the collapse the user had just performed.
        const expansionOwnedByUserRef = useRef(false)

        const toggleExpanded = useCallback(() => {
            expansionOwnedByUserRef.current = true
            setIsExpanded((previous) => !previous)
        }, [])

        const streamingContentKey = useMemo(() => buildStreamingKey(file.lines), [file.lines])

        useEffect(() => {
            const container = scrollContainerRef.current
            if (!isExpanded || !isStreaming || !shouldFollowRef.current || !container) return
            isProgrammaticScrollRef.current = true
            container.scrollTop = container.scrollHeight - container.clientHeight
            requestAnimationFrame(() => {
                isProgrammaticScrollRef.current = false
            })
        }, [isExpanded, isStreaming, streamingContentKey])

        useEffect(() => {
            // Auto-expand while streaming, but never force-close on completion:
            // collapsing the moment a batch of parallel replace_in_file cards
            // finishes caused visible layout jumps in the message list.
            if (isPartial && !expansionOwnedByUserRef.current) {
                setIsExpanded(true)
            }
        }, [isPartial])

        const handleScroll = () => {
            const container = scrollContainerRef.current
            if (!container || isProgrammaticScrollRef.current) return
            const { scrollTop, scrollHeight, clientHeight } = container
            shouldFollowRef.current = Math.abs(scrollHeight - clientHeight - scrollTop) < 10
        }

        const handleOpenFile = (event: React.MouseEvent) => {
            event.stopPropagation()
            if (file.path) {
                const pathWithLine = startLineNumber ? `${file.path}:${startLineNumber}` : file.path
                FileServiceClient.openFileRelativePath(StringRequest.create({ value: pathWithLine })).catch(console.error)
            }
        }

        const actionStyle = ACTION_STYLES[file.action as keyof typeof ACTION_STYLES] ?? ACTION_STYLES.default
        const ActionIcon = actionStyle.icon

        const lineNumbers = useMemo(() => {
            if (startLineNumber === undefined) return undefined
            let oldLine = startLineNumber
            let newLine = startLineNumber
            return file.lines.map((line) => {
                const isAddition = line.startsWith("+")
                const isDeletion = line.startsWith("-")
                const isContext = !isAddition && !isDeletion
                if (isDeletion) {
                    const d = oldLine
                    oldLine++
                    return d
                }
                const d = newLine
                newLine++
                if (isContext) oldLine++
                return d
            })
        }, [file.lines, startLineNumber])

        return (
            <div className="bg-code rounded-sm border border-editor-group-border overflow-hidden">
                <button
                    className="w-full flex items-center gap-2 p-2 bg-code transition-colors justify-between cursor-pointer"
                    onClick={toggleExpanded}
                    type="button">
                    <div className="flex items-center gap-3 flex-1 w-full overflow-hidden">
                        <div className={cn("flex items-center gap-2 w-full", actionStyle.borderClass)}>
                            <ActionIcon className={cn("w-5 h-5", actionStyle.iconClass)} />
                            <span
                                className="font-medium truncate hover:underline hover:text-link"
                                onClick={handleOpenFile}
                                title="Open file in editor">
                                {file.path}
                            </span>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        {hasError || startLineNumber === undefined ? (
                            <div className="text-xs text-error">{file.lines.length}</div>
                        ) : (
                            <DiffStats additions={file.additions} deletions={file.deletions} />
                        )}
                        <span
                            className="p-1 hover:bg-description/20 rounded-xs transition-colors"
                            onClick={handleOpenFile}
                            title="Open file in editor">
                            <SquareArrowOutUpRightIcon className="size-2 text-description hover:text-foreground" />
                        </span>
                    </div>
                </button>
                {isExpanded &&
                    (hasError ? (
                        <CodeAccordian code={file.lines.join("\n")} isExpanded={isExpanded} onToggleExpand={toggleExpanded} />
                    ) : (
                        <div
                            className="border-t border-code-block-background max-h-80 overflow-y-auto overflow-x-auto"
                            onScroll={handleScroll}
                            ref={scrollContainerRef}>
                            <div className="font-mono text-xs w-max min-w-full">
                                {file.lines.map((line, index) => (
                                    <DiffLine
                                        key={`${index}-${line.slice(0, 20)}`}
                                        line={line}
                                        lineNumber={lineNumbers?.[index]}
                                    />
                                ))}
                            </div>
                        </div>
                    ))}
                {hasError && (
                    <div className="border-t border-error/30 px-2 py-1 text-xs font-bold bg-error/10 text-error">
                        {blockError}
                    </div>
                )}
            </div>
        )
    },
    (prev, next) =>
        prev.isStreaming === next.isStreaming &&
        prev.isPartial === next.isPartial &&
        prev.startLineNumber === next.startLineNumber &&
        prev.blockError === next.blockError &&
        prev.file.path === next.file.path &&
        prev.file.action === next.file.action &&
        prev.file.additions === next.file.additions &&
        prev.file.deletions === next.file.deletions &&
        prev.file.lines === next.file.lines,
)

/**
 * Build a stable signature for streamed diff content updates.
 *
 * @param lines Diff lines currently rendered in the file block.
 * @returns Signature that changes when the stream appends or updates the tail line.
 */
function buildStreamingKey(lines: string[]): string {
    const lastLine = lines.at(-1) ?? ""
    return `${lines.length}:${lastLine}`
}

const DiffStats = memo<{ additions: number; deletions: number }>(({ additions, deletions }) => (
    <div className="text-xs text-gray-500 flex">
        {additions > 0 && <span className="text-success">+{additions}</span>}
        {additions > 0 && deletions > 0 && <span className="mx-1">|</span>}
        {deletions > 0 && <span className="text-error">-{deletions}</span>}
    </div>
))

const DiffLine = memo<{ line: string; lineNumber?: number; showLineNumberColumn?: boolean }>(
    ({ line, lineNumber, showLineNumberColumn = true }) => {
        const isAddition = line.startsWith("+")
        const isDeletion = line.startsWith("-")
        const markerWidth = line[1] === " " ? 2 : 1
        const code = isAddition || isDeletion ? line.slice(markerWidth) : line
        const prefix = isAddition ? "+" : isDeletion ? "-" : " "
        return (
            <div
                className={cn(
                    "flex text-xs font-mono",
                    isAddition && "bg-green-500/10",
                    isDeletion && "bg-red-500/10",
                    isAddition && "border-l-4 border-l-green-500",
                    isDeletion && "border-l-4 border-l-red-500",
                    !isAddition && !isDeletion && "border-l-4 border-l-transparent",
                )}>
                {showLineNumberColumn && (
                    <span
                        className={cn(
                            "w-10 min-w-10 text-right pr-2 py-0.5 select-none border-r border-code-block-background/50",
                            isAddition && "text-green-400/60",
                            isDeletion && "text-red-400/60",
                            !isAddition && !isDeletion && "text-description/50",
                        )}>
                        {lineNumber ?? ""}
                    </span>
                )}
                <span
                    className={cn(
                        "w-4 min-w-4 text-center py-0.5 select-none",
                        isAddition && "text-green-400",
                        isDeletion && "text-red-400",
                        !isAddition && !isDeletion && "text-description/50",
                    )}>
                    {prefix}
                </span>
                <span
                    className={cn(
                        "flex-1 pr-2 py-0.5 whitespace-nowrap",
                        isAddition && "text-green-400",
                        isDeletion && "text-red-400",
                        !isAddition && !isDeletion && "text-editor-foreground",
                    )}>
                    {code}
                </span>
            </div>
        )
    },
)

// ---- parsing functions (unchanged) ----
interface ParseResult {
    parsedFiles: Patch[]
    isStreaming: boolean
}

function parsePatch(patch: string | string[], path: string, action?: string): ParseResult {
    // Backend now sends pre-formatted "+"/"-" prefixed lines directly.
    // SEARCH/REPLACE parsing is handled entirely by the backend.
    const fileAction = action || "Update"

    // Array input: each element is a separate block
    if (Array.isArray(patch)) {
        const files: Patch[] = patch.map((blockContent) => {
            const lines = blockContent.split("\n")
            const additions = lines.filter((l) => l.startsWith("+")).length
            const deletions = lines.filter((l) => l.startsWith("-")).length
            return { action: fileAction, path, lines, additions, deletions }
        })
        return { parsedFiles: files, isStreaming: false }
    }

    const patchStr = patch
    if (patchStr.includes(MARKERS.NEW_BEGIN)) {
        const endIndex = patchStr.indexOf(MARKERS.NEW_END)
        const isComplete = endIndex !== -1
        const beginIndex = patchStr.indexOf(MARKERS.NEW_BEGIN)
        const contentStart = beginIndex + MARKERS.NEW_BEGIN.length
        const contentEnd = isComplete ? endIndex : patchStr.length
        const patchContent = patchStr.substring(contentStart, contentEnd).trim()
        const parsed = parseNewFormat(patchContent)
        if (parsed.length > 0) return { parsedFiles: parsed, isStreaming: !isComplete }
    }
    if (path && patchStr) {
        // Multi-block content: blocks separated by "\n\n" (empty line)
        const blockContents = patchStr.split(/\n\n+/)
        const files: Patch[] = []
        for (const blockContent of blockContents) {
            if (!blockContent.trim()) continue
            const lines = blockContent.split("\n")
            const additions = lines.filter((l) => l.startsWith("+")).length
            const deletions = lines.filter((l) => l.startsWith("-")).length
            files.push({ action: fileAction, path, lines, additions, deletions })
        }
        if (files.length > 0) {
            return { parsedFiles: files, isStreaming: false }
        }
        // Fallback: single Patch for backward compatibility
        const lines = patchStr.split("\n")
        const additions = lines.filter((l) => l.startsWith("+")).length
        const deletions = lines.filter((l) => l.startsWith("-")).length
        return {
            parsedFiles: [{ action: fileAction, path, lines, additions, deletions }],
            isStreaming: false,
        }
    }
    return { parsedFiles: [], isStreaming: false }
}

function parseNewFormat(content: string): Patch[] {
    const files: Patch[] = []
    const lines = content.split("\n")
    let currentFile: { action: string; path: string } | null = null
    let currentChunk: Patch | null = null
    const push = () => {
        if (currentChunk && currentChunk.lines.length > 0) files.push(currentChunk)
    }
    const startChunk = () => {
        if (!currentFile) return
        push()
        currentChunk = { action: currentFile.action, path: currentFile.path, lines: [], additions: 0, deletions: 0 }
    }
    for (const line of lines) {
        const fm = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/)
        if (fm) {
            push()
            currentFile = { action: fm[1], path: fm[2].trim() }
            currentChunk = null
        } else if (line.trim().startsWith("@@")) {
            startChunk()
        } else if (currentFile && line.trim()) {
            if (!currentChunk)
                currentChunk = { action: currentFile.action, path: currentFile.path, lines: [], additions: 0, deletions: 0 }
            currentChunk.lines.push(line)
            if (line[0] === "+") currentChunk.additions++
            else if (line[0] === "-") currentChunk.deletions++
        }
    }
    push()
    return files
}
