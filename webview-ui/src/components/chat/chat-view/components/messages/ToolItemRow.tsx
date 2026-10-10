import { type ComponentType, useLayoutEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { layoutToolRow, TOOL_ROW_GAP, TOOL_ROW_ICON_WIDTH, type ToolItemText, type ToolRowLayout } from "./tool-row-layout"

interface ToolItemRowProps {
    icon: ComponentType<{ className?: string }>
    text: ToolItemText
    isActive?: boolean
    ariaExpanded?: boolean
    onActivate?: () => void
}

/** Observe both available space and a font-inheriting probe; neither depends on fitted text. */
function useToolRowLayout(text: ToolItemText) {
    const rowRef = useRef<HTMLButtonElement>(null)
    const probeRef = useRef<HTMLSpanElement>(null)
    const [layout, setLayout] = useState<ToolRowLayout | null>(null)

    useLayoutEffect(() => {
        const row = rowRef.current
        const probe = probeRef.current
        const parts = text.row
        if (!row || !probe || !parts) {
            setLayout(null)
            return
        }
        let frame: number | undefined
        const update = () => {
            const style = getComputedStyle(row)
            const width =
                row.getBoundingClientRect().width -
                Number.parseFloat(style.paddingLeft || "0") -
                Number.parseFloat(style.paddingRight || "0") -
                Number.parseFloat(style.borderLeftWidth || "0") -
                Number.parseFloat(style.borderRightWidth || "0")
            // Hidden/unmounted layout has no useful geometry yet. ResizeObserver will retry when shown.
            if (width <= 0) return
            const cache = new Map<string, number>([["", 0]])
            const measure = (value: string) => {
                const cached = cache.get(value)
                if (cached !== undefined) return cached
                probe.textContent = value
                const measured = probe.getBoundingClientRect().width
                cache.set(value, measured)
                return measured
            }
            const next = layoutToolRow(parts, width, measure)
            // Restoring a stable probe prevents a ResizeObserver feedback loop and detects font changes.
            probe.textContent = text.displayText
            setLayout((previous) =>
                previous &&
                Object.keys(next).every((key) => previous[key as keyof ToolRowLayout] === next[key as keyof ToolRowLayout])
                    ? previous
                    : next,
            )
        }
        const schedule = () => {
            if (frame !== undefined) cancelAnimationFrame(frame)
            frame = requestAnimationFrame(update)
        }
        update()
        const observer = new ResizeObserver(schedule)
        observer.observe(row)
        observer.observe(probe)
        document.fonts?.addEventListener("loadingdone", schedule)
        return () => {
            observer.disconnect()
            if (frame !== undefined) cancelAnimationFrame(frame)
            document.fonts?.removeEventListener("loadingdone", schedule)
        }
    }, [text])

    return { rowRef, probeRef, layout }
}

/** Single-line target and protected metadata, with a viewport-sized, fully selectable hover surface. */
export function ToolItemRow({ icon: Icon, text, isActive, ariaExpanded, onActivate }: ToolItemRowProps) {
    const { rowRef, probeRef, layout } = useToolRowLayout(text)
    const parts = text.row
    const fitted =
        layout ??
        (parts
            ? {
                  mode: "full",
                  showIcon: true,
                  prefix: parts.prefix ?? "",
                  prefixSeparator: parts.prefix ? (parts.prefixSeparator ?? " ") : "",
                  path: parts.path,
                  suffixSeparator: parts.suffix ? (parts.suffixSeparator ?? " ") : "",
                  suffix: parts.suffix ?? "",
              }
            : null)

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <Button
                    aria-busy={isActive || undefined}
                    aria-disabled={isActive || undefined}
                    aria-expanded={ariaExpanded}
                    aria-label={text.tooltipText}
                    className={cn(
                        "relative flex w-full justify-start gap-0 text-[13px] text-description py-[1px] min-w-0 max-w-full px-0 leading-tight -my-0.5 overflow-visible",
                        isActive ? "cursor-default" : "cursor-pointer hover:text-link",
                    )}
                    data-layout={fitted?.mode ?? "summary"}
                    onClick={isActive ? undefined : onActivate}
                    ref={rowRef}
                    size="icon"
                    variant="text">
                    {(fitted?.showIcon ?? true) && (
                        <span
                            aria-hidden="true"
                            className={cn("flex shrink-0 opacity-70 [&_svg]:size-[12px]", isActive && "animate-pulse")}
                            style={{ width: TOOL_ROW_ICON_WIDTH, marginRight: TOOL_ROW_GAP }}>
                            <Icon />
                        </span>
                    )}
                    {fitted ? (
                        <>
                            {fitted.path && (
                                <span className="flex min-w-0 whitespace-pre text-left" data-tool-part="target">
                                    {fitted.prefix && (
                                        <span data-tool-part="prefix">
                                            {fitted.prefix}
                                            {fitted.prefixSeparator}
                                        </span>
                                    )}
                                    <span data-tool-part="path">{fitted.path}</span>
                                </span>
                            )}
                            {fitted.suffixSeparator && (
                                <span aria-hidden="true" className="shrink-0 whitespace-pre">
                                    {fitted.suffixSeparator}
                                </span>
                            )}
                            {fitted.suffix && (
                                <span className="shrink-0 whitespace-pre" data-tool-part="suffix">
                                    {fitted.suffix}
                                </span>
                            )}
                        </>
                    ) : (
                        <span className="min-w-0 truncate text-left">{text.displayText}</span>
                    )}
                    <span
                        aria-hidden="true"
                        data-tool-part="measure"
                        ref={probeRef}
                        style={{
                            position: "fixed",
                            visibility: "hidden",
                            pointerEvents: "none",
                            whiteSpace: "pre",
                            width: "max-content",
                            left: 0,
                            top: 0,
                            font: "inherit",
                            letterSpacing: "inherit",
                        }}>
                        {text.displayText}
                    </span>
                </Button>
            </TooltipTrigger>
            <TooltipContent
                align="start"
                className="[&>span]:min-w-0 [&>span]:w-full"
                side="bottom"
                style={{ width: "80vw", maxWidth: "80vw", boxSizing: "border-box" }}>
                <span className="select-text whitespace-pre-wrap break-all font-mono text-[11px]">{text.tooltipText}</span>
            </TooltipContent>
        </Tooltip>
    )
}
