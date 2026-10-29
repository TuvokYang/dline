import { BarChart3, Coins, Gauge, History, LineChart, type LucideIcon } from "lucide-react"
import type { ComponentProps } from "react"

export type MetricIconKind = "tpm" | "rpm" | "tokens" | "bar" | "line" | "history"

interface MetricIconProps extends Omit<ComponentProps<"svg">, "aria-label" | "role"> {
    kind: MetricIconKind
    ariaLabel?: string
    decorative?: boolean
    size?: number
}

const ICONS: Record<MetricIconKind, LucideIcon> = {
    bar: BarChart3,
    history: History,
    line: LineChart,
    rpm: Gauge,
    tokens: Coins,
    tpm: Gauge,
}

const DEFAULT_LABELS: Record<MetricIconKind, string> = {
    bar: "Bar chart",
    history: "Metrics history",
    line: "Line chart",
    rpm: "Requests per minute",
    tokens: "Token consumption",
    tpm: "Tokens per minute",
}

/** Render a semantic metrics icon while keeping icon selection in one reusable component. */
export function MetricIcon({ ariaLabel, className, decorative = true, kind, size = 14, ...props }: MetricIconProps) {
    const Icon = ICONS[kind]
    const accessibleLabel = ariaLabel ?? DEFAULT_LABELS[kind]

    return (
        <Icon
            {...props}
            aria-hidden={decorative ? true : undefined}
            aria-label={decorative ? undefined : accessibleLabel}
            className={className}
            focusable="false"
            role={decorative ? undefined : "img"}
            size={size}
        />
    )
}
