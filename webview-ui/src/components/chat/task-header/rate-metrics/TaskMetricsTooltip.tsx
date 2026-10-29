import { autoUpdate, flip, offset, shift, size, useFloating } from "@floating-ui/react"
import type { TaskRateMetricPoint } from "@shared/proto/dline/task"
import { useLayoutEffect } from "react"
import { createPortal } from "react-dom"
import {
    formatTaskMetricsSeriesValue,
    readTaskMetricsSeriesValue,
    type TaskMetricsSeriesDescriptor,
    type TaskMetricsSeriesKey,
} from "./TaskMetricsChartModel"

export interface TaskMetricsTooltipTarget {
    readonly point: TaskRateMetricPoint
    readonly element: SVGElement
}

interface TaskMetricsTooltipProps {
    readonly target?: TaskMetricsTooltipTarget
    readonly descriptors: readonly TaskMetricsSeriesDescriptor[]
    readonly enabledSeries: ReadonlySet<TaskMetricsSeriesKey>
    readonly degraded: boolean
}

/** Position one aggregate time-bucket tooltip beside the active SVG point or bar. */
export function TaskMetricsTooltip({ target, descriptors, enabledSeries, degraded }: TaskMetricsTooltipProps) {
    const boundary = target?.element.closest('[role="dialog"]') ?? undefined
    const { refs, floatingStyles } = useFloating({
        open: target !== undefined,
        placement: "top",
        strategy: "fixed",
        middleware: [
            offset(8),
            flip(boundary ? { boundary } : undefined),
            size({
                boundary,
                padding: 8,
                apply({ elements }) {
                    const boundaryWidth = boundary?.getBoundingClientRect().width
                    elements.floating.style.maxWidth =
                        boundaryWidth === undefined ? "calc(100vw - 16px)" : `${Math.max(0, boundaryWidth - 16)}px`
                },
            }),
            shift({ boundary, padding: 8 }),
        ],
        whileElementsMounted: autoUpdate,
    })
    const setReference = refs.setReference

    useLayoutEffect(() => {
        setReference(target?.element ?? null)
    }, [setReference, target?.element])

    if (!target) return null

    return createPortal(
        <div
            className="pointer-events-none z-60 max-h-[45vh] max-w-md overflow-auto rounded-sm border border-input-placeholder/20 bg-background p-2 text-xs shadow-lg"
            data-anchor-bucket-start-ms={target.point.bucketStartMs}
            ref={refs.setFloating}
            role="tooltip"
            style={floatingStyles}>
            <div className="mb-1 font-medium">{new Date(target.point.bucketStartMs).toLocaleString()}</div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                {descriptors
                    .filter(({ key }) => enabledSeries.has(key))
                    .map((descriptor) => {
                        const value = readTaskMetricsSeriesValue(target.point, descriptor.key) ?? 0
                        return (
                            <div key={descriptor.key}>
                                {descriptor.label}: {formatTaskMetricsSeriesValue(descriptor, value)}
                            </div>
                        )
                    })}
                <div>History: {degraded ? "Degraded" : "Complete"}</div>
            </div>
        </div>,
        target.element.ownerDocument.body,
    )
}
