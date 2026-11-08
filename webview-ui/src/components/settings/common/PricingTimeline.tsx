import { useUiTranslation } from "@/i18n/UiLanguageProvider"

export interface PricingInterval {
    readonly startMinute: number
    readonly endMinute: number
    readonly kind?: "peak" | "offPeak"
}

export function formatPricingClock(minutes: number): string {
    return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`
}

export function formatPricingOffset(minutes: number): string {
    return `UTC${minutes < 0 ? "-" : "+"}${formatPricingClock(Math.abs(minutes))}`
}

/** Shared geometry for the declared editor windows and the resolved seller day. */
export function PricingTimeline({
    windows,
    label,
    peakOffPeakLabels = false,
}: {
    windows: readonly PricingInterval[]
    label: string
    peakOffPeakLabels?: boolean
}) {
    const { t } = useUiTranslation()
    return (
        <div>
            <svg
                aria-label={label}
                className="block h-3 w-full overflow-hidden rounded-xs"
                preserveAspectRatio="none"
                role="img"
                viewBox="0 0 1440 12">
                <title>{label}</title>
                <rect fill="var(--vscode-charts-green, #22c55e)" height="12" opacity="0.45" width="1440" x="0" />
                {windows.map((window, index) => (
                    <rect
                        data-rate-kind={window.kind}
                        data-window-index={index}
                        fill={
                            window.kind === "offPeak"
                                ? "var(--vscode-charts-green, #22c55e)"
                                : "var(--vscode-charts-orange, #f59e0b)"
                        }
                        height="12"
                        key={`${window.startMinute}-${window.endMinute}`}
                        opacity={window.kind === "offPeak" ? 0.45 : undefined}
                        width={window.endMinute - window.startMinute}
                        x={window.startMinute}>
                        <title>
                            {formatPricingClock(window.startMinute)} – {formatPricingClock(window.endMinute)}
                        </title>
                    </rect>
                ))}
            </svg>
            <div aria-hidden className="mt-1 flex justify-between text-[10px] text-description">
                <span>00</span>
                <span>06</span>
                <span>12</span>
                <span>18</span>
                <span>24</span>
            </div>
            <div className="mt-1 flex gap-3 text-[11px]">
                <span style={{ color: "var(--vscode-charts-green, #22c55e)" }}>
                    {peakOffPeakLabels ? t("settings.ui.offPeakRates") : t("settings.ui.defaultRates")}
                </span>
                {(!peakOffPeakLabels || windows.some((window) => window.kind !== "offPeak")) && (
                    <span style={{ color: "var(--vscode-charts-orange, #f59e0b)" }}>
                        {peakOffPeakLabels ? t("settings.ui.peakRates") : t("settings.ui.windowRates")}
                    </span>
                )}
            </div>
        </div>
    )
}
