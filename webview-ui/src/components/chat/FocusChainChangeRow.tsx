import { isFocusChainItem } from "@shared/focus-chain-utils"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"

interface ParsedItem {
    text: string
    heading: string | null
    /** Prefix marker: "[+]" = selected this round, "[-]" = rejected this round, "done" = already [x] */
    prefix: "[+]" | "[-]" | "done" | null
}

interface FocusChainChangeRowProps {
    plan: string
    reason: string
    /** Whether this focus chain change was auto-approved (no user interaction needed) */
    autoApproved?: boolean
    /** Controlled expansion state for the message row. */
    isExpanded?: boolean
    /** Toggle the controlled expansion state. */
    onToggleExpand?: () => void
    onSelectionChange?: (selectedPlan: string) => void
}

/** Check if plan has prefix markers ([+] or [-]), meaning it was already approved */
export function hasPlanMarkers(plan: string): boolean {
    return /\[\+\]|\[-\]/.test(plan)
}

/**
 * Parse plan text into structured items.
 * - "- [x] item" → prefix="done" (already completed, no checkbox)
 * - "[+] - [ ] item" → prefix="[+]" (selected this approval round)
 * - "[-] - [ ] item" → prefix="[-]" (rejected this approval round)
 * - "- [ ] item" → prefix=null (pending, needs checkbox)
 */
function parsePlan(plan: string): { title: string | null; items: ParsedItem[] } {
    const lines = plan.split("\n")
    let title: string | null = null
    const items: ParsedItem[] = []
    let currentHeading: string | null = null

    for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        if (trimmed.startsWith("# ") && !trimmed.startsWith("## ")) {
            title = trimmed.replace(/^#\s+/, "")
        } else if (trimmed.startsWith("## ")) {
            currentHeading = trimmed.replace(/^##\s+/, "")
        } else if (isFocusChainItem(trimmed)) {
            let prefix: ParsedItem["prefix"] = null
            let text = trimmed

            if (/^- \[x\]/i.test(trimmed)) {
                prefix = "done"
                text = trimmed.replace(/^-\s*\[[xX]\]\s*/, "").trim()
            } else if (/^\[\+\]/.test(trimmed)) {
                prefix = "[+]"
                text = trimmed.replace(/^\[\+\]\s*-\s*\[\s*\]\s*/, "").trim()
            } else if (/^\[-\]/.test(trimmed)) {
                prefix = "[-]"
                text = trimmed.replace(/^\[-\]\s*-\s*\[\s*\]\s*/, "").trim()
            } else {
                text = trimmed.replace(/^-\s*\[\s*\]\s*/, "").trim()
            }
            items.push({ text, heading: currentHeading, prefix })
        }
    }
    return { title, items }
}

/**
 * Build plan text with prefix markers for message.text persistence.
 * Selected items → "[+] - [ ]", unselected → "[-] - [ ]".
 * Items with prefix="done" (already [x]) are output as "- [x]".
 */
export function buildSelectedPlan(plan: string, selected: Set<number>): string {
    const { title, items } = parsePlan(plan)
    const selectedLines: string[] = []
    let lastHeading: string | null = null
    for (let i = 0; i < items.length; i++) {
        const item = items[i]
        if (item.heading && item.heading !== lastHeading) {
            selectedLines.push(`## ${item.heading}`)
            lastHeading = item.heading
        }
        if (item.prefix === "done") {
            selectedLines.push(`- [x] ${item.text}`)
        } else if (selected.has(i)) {
            selectedLines.push(`[+] - [ ] ${item.text}`)
        } else {
            selectedLines.push(`[-] - [ ] ${item.text}`)
        }
    }
    return title ? `# ${title}\n${selectedLines.join("\n")}` : selectedLines.join("\n")
}

// useRef storage for synchronous reads — avoids useEffect async race
const selectedRef: { current: Set<number> | null } = { current: null }
const planRef: { current: string } = { current: "" }

/** Get the currently selected plan with [+]/[-] prefix markers for message.text */
export function getFocusChainSelectedPlan(): string {
    if (!selectedRef.current || !planRef.current) return planRef.current
    return buildSelectedPlan(planRef.current, selectedRef.current)
}

export const FocusChainChangeRow: React.FC<FocusChainChangeRowProps> = ({
    plan,
    reason,
    autoApproved,
    isExpanded = true,
    onToggleExpand,
    onSelectionChange,
}) => {
    const { title, items } = useMemo(() => parsePlan(plan), [plan])

    // Auto-approved plans are not interactive — all items pre-selected, checkboxes disabled
    const isActive = useMemo(() => !autoApproved && !hasPlanMarkers(plan), [autoApproved, plan])

    const [selected, setSelected] = useState<Set<number>>(() => {
        if (hasPlanMarkers(plan)) {
            const init = new Set<number>()
            items.forEach((item, i) => {
                if (item.prefix === "[+]") init.add(i)
            })
            return init
        }
        if (selectedRef.current && planRef.current === plan) {
            return selectedRef.current
        }
        // All pending items selected by default (skip done items)
        const all = new Set<number>()
        items.forEach((_, i) => {
            if (items[i].prefix !== "done") all.add(i)
        })
        return all
    })

    const onSelectionChangeRef = useRef(onSelectionChange)
    onSelectionChangeRef.current = onSelectionChange

    useEffect(() => {
        selectedRef.current = selected
        planRef.current = plan
    }, [selected, plan])

    useEffect(() => {
        onSelectionChangeRef.current?.(getFocusChainSelectedPlan())
    }, [])

    const toggleItem = useCallback((index: number) => {
        setSelected((prev) => {
            const next = new Set(prev)
            next.has(index) ? next.delete(index) : next.add(index)
            selectedRef.current = next
            return next
        })
    }, [])

    const hasMarkers = hasPlanMarkers(plan)
    const hasApproved = hasMarkers && items.some((item) => item.prefix === "[+]")
    const isRejected = hasMarkers && !hasApproved
    const bgClass = isRejected ? "bg-red-500/10" : hasApproved ? "bg-green-500/10" : "bg-toolbar-hover/30"

    const toggleLabel = isExpanded ? "Collapse focus-chain change" : "Expand focus-chain change"

    return (
        <div className={`flex flex-col gap-2 p-3 rounded border border-description/50 ${bgClass}`}>
            {(reason || autoApproved) && (
                <button
                    aria-label={toggleLabel}
                    className="w-full text-base font-bold border-b border-description/20 pb-1 mb-2 flex justify-between items-center gap-2 text-left"
                    disabled={!onToggleExpand}
                    onClick={onToggleExpand}
                    type="button">
                    {reason ? (
                        <span className="flex items-center gap-1 min-w-0 overflow-hidden flex-1">
                            <span className="codicon codicon-checklist shrink-0 text-sm" />
                            <span className="truncate">{reason}</span>
                        </span>
                    ) : (
                        <span />
                    )}
                    <div className="flex items-center gap-1 shrink-0 whitespace-nowrap">
                        {autoApproved && (
                            <span className="text-xs font-semibold text-green-600 bg-green-100 rounded px-2 py-0.5">
                                Auto Approved
                            </span>
                        )}
                        {isRejected && (
                            <span className="text-xs font-semibold text-red-600 bg-red-100 rounded px-2 py-0.5">Rejected</span>
                        )}
                        {hasApproved && (
                            <span className="text-xs font-semibold text-green-600 bg-green-100 rounded px-2 py-0.5">
                                Approved
                            </span>
                        )}
                    </div>
                </button>
            )}

            {isExpanded && (
                <div className="max-h-[80vh] overflow-y-auto pr-1" data-testid="focus-chain-change-details">
                    {title && <div className="text-base font-bold">{title}</div>}

                    {items.length > 0 ? (
                        items.map((item, idx) => {
                            const prevHeading = idx > 0 ? items[idx - 1].heading : null
                            const showHeading = item.heading && item.heading !== prevHeading
                            return (
                                <React.Fragment key={idx}>
                                    {showHeading && (
                                        <div className="text-sm font-medium text-muted-foreground mt-1">{item.heading}</div>
                                    )}
                                    <div className="flex items-center gap-1.5">
                                        {item.prefix === "done" ? (
                                            <span className="text-sm text-green-500">✓</span>
                                        ) : (
                                            <VSCodeCheckbox
                                                checked={selected.has(idx)}
                                                disabled={!isActive}
                                                onChange={() => toggleItem(idx)}
                                            />
                                        )}
                                        <span className="text-base">{item.text}</span>
                                    </div>
                                </React.Fragment>
                            )
                        })
                    ) : (
                        <div className="text-base text-muted-foreground italic">{plan}</div>
                    )}
                </div>
            )}
        </div>
    )
}
