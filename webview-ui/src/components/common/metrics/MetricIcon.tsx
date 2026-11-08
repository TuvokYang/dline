import { BarChart3, Coins, Gauge, History, LineChart, type LucideIcon } from "lucide-react"
import type { ComponentProps } from "react"
import type { UiMessageKey } from "@/i18n/messages"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"

export type MetricIconKind = "tpm" | "rpm" | "tokens" | "bar" | "line" | "history"

interface MetricIconProps extends Omit<ComponentProps<"svg">, "aria-label" | "role"> {
    kind: MetricIconKind
    /** Overrides the localized default label; the caller owns this text. */
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

const DEFAULT_LABEL_KEYS: Record<MetricIconKind, Extract<UiMessageKey, `shell.metric.${string}`>> = {
    bar: "shell.metric.bar",
    history: "shell.metric.history",
    line: "shell.metric.line",
    rpm: "shell.metric.rpm",
    tokens: "shell.metric.tokens",
    tpm: "shell.metric.tpm",
}

/** Render a semantic metrics icon while keeping icon selection in one reusable component. */
export function MetricIcon({ ariaLabel, className, decorative = true, kind, size = 14, ...props }: MetricIconProps) {
    const { t } = useUiTranslation()
    const Icon = ICONS[kind]
    const accessibleLabel = ariaLabel ?? t(DEFAULT_LABEL_KEYS[kind])

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
