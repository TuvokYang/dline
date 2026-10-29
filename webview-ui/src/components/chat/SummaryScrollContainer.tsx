import type { ReactNode } from "react"

interface SummaryScrollContainerProps {
    children: ReactNode
    className?: string
    maxHeight?: string
}

/** Keep long automatic and manual summaries inside a viewport-bounded scroll region. */
export function SummaryScrollContainer({ children, className, maxHeight = "60vh" }: SummaryScrollContainerProps) {
    return (
        <div
            className={`overflow-y-auto pr-1 ${maxHeight === "60vh" ? "max-h-[60vh]" : ""} ${className ?? ""}`.trim()}
            data-testid="summary-scroll-container"
            style={{ maxHeight, overflowY: "auto" }}>
            {children}
        </div>
    )
}
