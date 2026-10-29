import { cn } from "@heroui/react"
import { parseFocusChainItem } from "@shared/focus-chain-utils"
import { CheckIcon, CircleIcon } from "lucide-react"
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import LightMarkdown from "./LightMarkdown"

interface ChecklistRendererProps {
    text: string
}

interface ChecklistItem {
    checked: boolean
    text: string
}

interface ChecklistSection {
    heading: string | null
    items: ChecklistItem[]
}

const ChecklistRenderer: React.FC<ChecklistRendererProps> = ({ text }) => {
    const containerRef = useRef<HTMLDivElement>(null)
    const [lastCompletedIndex, setLastCompletedIndex] = useState(-1)
    const [isUserScrolling, setIsUserScrolling] = useState(false)
    const scrollTimeoutRef = useRef<NodeJS.Timeout>()

    const parseChecklistSections = (text: string): ChecklistSection[] => {
        const lines = text.split("\n")
        const sections: ChecklistSection[] = []
        let currentHeading: string | null = null
        let currentItems: ChecklistItem[] = []

        for (const line of lines) {
            const trimmedLine = line.trim()
            if (!trimmedLine) {
                continue
            }

            // Match ## headings as section titles
            if (trimmedLine.startsWith("## ")) {
                // Save previous section if it has items
                if (currentItems.length > 0) {
                    sections.push({ heading: currentHeading, items: [...currentItems] })
                }
                currentHeading = trimmedLine.replace(/^##\s+/, "")
                currentItems = []
                continue
            }

            // Match # headings as main title
            if (trimmedLine.startsWith("# ")) {
                if (currentItems.length > 0) {
                    sections.push({ heading: currentHeading, items: [...currentItems] })
                }
                currentHeading = trimmedLine.replace(/^#\s+/, "")
                currentItems = []
                continue
            }

            const parsed = parseFocusChainItem(trimmedLine)
            if (parsed) {
                currentItems.push({ checked: parsed.checked, text: parsed.text })
            }
        }

        // Save last section
        if (currentItems.length > 0) {
            sections.push({ heading: currentHeading, items: [...currentItems] })
        }

        return sections
    }

    const sections = parseChecklistSections(text)

    // Flatten all items for scroll tracking
    const items = useMemo(() => {
        const flat: ChecklistItem[] = []
        for (const section of sections) {
            for (const item of section.items) {
                flat.push(item)
            }
        }
        return flat
    }, [sections])

    // Handle user scroll detection
    // This prevents jumpy scrolling when the task is streaming and users are viewing the focus chain list
    const handleScroll = useCallback(() => {
        setIsUserScrolling(true)
        if (scrollTimeoutRef.current) {
            clearTimeout(scrollTimeoutRef.current)
        }
        scrollTimeoutRef.current = setTimeout(() => {
            setIsUserScrolling(false)
        }, 1000) // Reset after 1 second of no scrolling
    }, [])

    // Auto-scroll to show the most recently completed item when in scroll mode
    useEffect(() => {
        if (items.length >= 10 && containerRef.current && !isUserScrolling) {
            // Find the last completed item
            let currentLastCompletedIndex = -1
            for (let i = items.length - 1; i >= 0; i--) {
                if (items[i].checked) {
                    currentLastCompletedIndex = i
                    break
                }
            }

            // Only auto-scroll if there's a new completion or first time
            if (currentLastCompletedIndex >= 0 && currentLastCompletedIndex !== lastCompletedIndex) {
                setLastCompletedIndex(currentLastCompletedIndex)

                // Use scrollIntoView for more accurate positioning
                const container = containerRef.current
                const itemElements = container.children
                if (itemElements[currentLastCompletedIndex]) {
                    itemElements[currentLastCompletedIndex].scrollIntoView({
                        behavior: "smooth",
                        block: "start",
                    })
                }
            }
        }
    }, [items, lastCompletedIndex, isUserScrolling])

    // Cleanup timeout on unmount
    useEffect(() => {
        return () => {
            if (scrollTimeoutRef.current) {
                clearTimeout(scrollTimeoutRef.current)
            }
        }
    }, [])

    if (items.length === 0) {
        // If no checklist items found, return the original text
        return <div style={{ whiteSpace: "pre-wrap" }}>{text}</div>
    }

    return (
        <div
            className={cn(
                "scrollable text-sm flex flex-col gap-1",
                items.length >= 10 ? "max-h-52 overflow-y-auto" : "h-auto visible",
            )}
            onScroll={handleScroll}
            ref={containerRef}
            style={{
                lineHeight: "1.3",
            }}>
            {sections.map((section, sectionIdx) => (
                <div className="flex flex-col gap-0.5" key={`section-${sectionIdx}`}>
                    {section.heading && (
                        <div className="text-xs font-semibold text-muted-foreground/80 pt-1 pb-0.5 first:pt-0">
                            {section.heading}
                        </div>
                    )}
                    {section.items.map((item, itemIdx) => {
                        // Calculate global index for key generation
                        const _globalIdx = items.indexOf(item)
                        return (
                            <div className="flex items-center gap-1.5 p-0.5" key={`checklist-item-${sectionIdx}-${itemIdx}`}>
                                <span className={cn("text-sm shrink-0", item.checked ? "text-success" : "text-foreground")}>
                                    {item.checked ? <CheckIcon size={10} /> : <CircleIcon size={10} />}
                                </span>
                                <div
                                    className={cn(
                                        "text-sm break-words flex-1 leading-5",
                                        item.checked ? "text-description" : "text-foreground",
                                    )}>
                                    <LightMarkdown compact text={item.text} />
                                </div>
                            </div>
                        )
                    })}
                </div>
            ))}
        </div>
    )
}

export default ChecklistRenderer
