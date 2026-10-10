import { StringRequest } from "@shared/proto/dline/common"
import { memo, useState } from "react"
import { cn } from "@/lib/utils"
import { FileServiceClient } from "@/services/grpc-client"

export interface MatchEntry {
    file: string
    line: number
    column: number
    originalText: string
    newText: string
    diff: string
}

interface EditResultRowProps {
    content: string
    isExpanded: boolean
    onToggleExpand: () => void
    toolType?: string
    matches?: MatchEntry[]
}

const OLD_BG_CLASS = "bg-red-500/20"
const NEW_BG_CLASS = "bg-green-500/20"

export const EditResultRow = memo<EditResultRowProps>(({ content, isExpanded, onToggleExpand, toolType, matches }) => {
    const [internalExpanded, setInternalExpanded] = useState(false)
    const expanded = isExpanded || internalExpanded
    const safe = content || ""
    const lines = safe.split("\n").filter(Boolean)
    const headerLine = lines[0] || ""
    const errorLine = headerLine.startsWith("Error:") ? headerLine : ""
    const cleanHeader = errorLine ? lines[1] || "Error" : headerLine
    const body = errorLine ? lines.slice(2) : lines.slice(1)
    if (!lines.length) return <div className="text-description text-sm py-1">Processing...</div>

    return (
        <>
            <div className="overflow-hidden rounded-[3px] border border-editor-group-border">
                <button
                    aria-label={expanded ? "Collapse" : "Expand"}
                    className={cn("text-description flex items-center cursor-pointer select-none w-full py-[9px] px-2.5 bg-code")}
                    onClick={() => {
                        setInternalExpanded(!internalExpanded)
                        onToggleExpand()
                    }}
                    tabIndex={0}
                    type="button">
                    <span className={`codicon ${getEditIcon(toolType)} mr-1.5 text-sm shrink-0`} />
                    {renderHeader(cleanHeader)}
                </button>
                {expanded && (
                    <div className="border-t border-editor-group-border p-2 text-sm max-h-60 overflow-y-auto">
                        {matches && matches.length > 0 ? renderMatches(matches) : renderBody(body)}
                    </div>
                )}
            </div>
            {errorLine ? (
                <div className="text-red-600 dark:text-red-400 font-bold text-xs mt-1 px-2.5">
                    {errorLine.replace("Error:", "").trim()}
                </div>
            ) : null}
        </>
    )
})

function renderHeader(text: string): React.ReactNode {
    // Parse: Prefix: old -> new (N files, N changes) (preview)?
    const m = text.match(/^([^:]+:\s*)(.+?)\s*->\s*(.+?)\s+(\(\d+ files, \d+ changes\))(?:\s*\((preview)\))?$/)
    if (!m) return <span>{text}</span>
    const [, prefix, oldText, newText, stats, dryTag] = m
    return (
        <>
            <span className="flex-1 min-w-0 whitespace-nowrap overflow-hidden text-ellipsis text-left">
                {prefix}
                <span className={cn("rounded-sm px-0.5", OLD_BG_CLASS)}>{oldText}</span>
                <span className="mx-1">{"->"}</span>
                <span className={cn("rounded-sm px-0.5 font-semibold", NEW_BG_CLASS)}>{newText}</span>
            </span>
            <span className="flex items-center gap-1 ml-auto shrink-0">
                <span className="text-xs font-semibold text-description">{renderStats(stats)}</span>
                {dryTag ? (
                    <span className="rounded-sm px-1 py-0.5 text-xs font-bold bg-yellow-200 dark:bg-yellow-800 text-yellow-800 dark:text-yellow-200">
                        {dryTag}
                    </span>
                ) : null}
            </span>
        </>
    )
}

function renderStats(text: string): React.ReactNode {
    // Highlight numbers in " (3 files, 5 changes)" with background
    const parts = text.split(/(\d+)/g)
    return parts.map((part, i) =>
        /^\d+$/.test(part) ? (
            <span className="rounded-sm px-0.5 bg-yellow-200 dark:bg-yellow-800 font-bold" key={i}>
                {part}
            </span>
        ) : (
            <span key={i}>{part}</span>
        ),
    )
}

function renderBody(lines: string[]): React.ReactNode {
    const els: React.ReactNode[] = []
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        // Path line: "path L:col"
        const pm = line.match(/^(\S+)\s+L(\d+):(\d+)$/)
        if (pm) {
            els.push(
                <button
                    className="flex items-center w-full text-left py-0.5 cursor-pointer whitespace-nowrap text-description font-medium hover:underline"
                    key={`p-${i}`}
                    onClick={() =>
                        FileServiceClient.openFileRelativePath(StringRequest.create({ value: `${pm[1]}:${pm[2]}` })).catch(
                            console.error,
                        )
                    }
                    type="button">
                    {pm[1]} L{pm[2]}:{pm[3]}
                </button>,
            )
            continue
        }
        const isOld = line.startsWith("- ")
        const isNew = line.startsWith("+ ")
        const bgClass = isOld ? OLD_BG_CLASS : isNew ? NEW_BG_CLASS : ""
        els.push(
            <div className={cn("whitespace-pre-wrap break-all py-0.5 px-1 rounded-sm text-sm", bgClass)} key={`l-${i}`}>
                {line}
            </div>,
        )
    }
    return <div className="space-y-0.5">{els}</div>
}

/** Render diff lines with inline fragment highlighting. */
function renderMatches(matches: MatchEntry[]): React.ReactNode {
    return (
        <div className="space-y-1">
            {matches.map((m, i) => (
                <div className="mb-1" key={i}>
                    <div
                        className="text-[11px] text-description opacity-60 cursor-pointer hover:underline mb-0.5"
                        onClick={() =>
                            FileServiceClient.openFileRelativePath(StringRequest.create({ value: `${m.file}:${m.line}` })).catch(
                                () => {},
                            )
                        }>
                        {m.file} L{m.line}:{m.column}
                    </div>
                    {renderDiffLines(m)}
                </div>
            ))}
        </div>
    )
}

/**
 * Render diff lines from a match.
 * - line: shallow red bg, originalText fragment gets line-through + deep red text
 * + line: shallow green bg, newText fragment gets bold + deep green text
 */
function renderDiffLines(m: MatchEntry): React.ReactNode {
    const lines = m.diff.split("\n")
    return lines.map((line, li) => {
        const isOld = line.startsWith("- ")
        const isNew = line.startsWith("+ ")
        if (!isOld && !isNew)
            return (
                <div className="text-xs px-2 py-0.5" key={li}>
                    {line}
                </div>
            )
        const bare = line.substring(2)
        const highlight = isOld ? m.originalText : m.newText
        return (
            <div
                className={cn(
                    "whitespace-pre-wrap break-all py-0.5 px-2 rounded-sm text-sm",
                    isOld ? "bg-red-500/20" : "bg-green-500/20",
                )}
                key={li}>
                {renderInlineHighlight(bare, highlight, isOld)}
            </div>
        )
    })
}

/**
 * Split text around highlight fragment.
 * Old: strikethrough + deep red. New: bold + deep green.
 */
function renderInlineHighlight(text: string, fragment: string, isOld: boolean): React.ReactNode {
    if (!fragment) return text
    const idx = text.indexOf(fragment)
    if (idx === -1) return text
    const before = text.substring(0, idx)
    const after = text.substring(idx + fragment.length)
    return (
        <>
            {before}
            <span className={isOld ? "line-through text-red-700 font-medium" : "font-bold text-green-700"}>{fragment}</span>
            {after}
        </>
    )
}

/** Return codicon class for rename/replace/edit tools. */
function getEditIcon(toolType?: string): string {
    switch (toolType) {
        case "renameSymbol":
            return "codicon-replace"
        case "replaceText":
            return "codicon-replace-all"
        default:
            return "codicon-edit"
    }
}
