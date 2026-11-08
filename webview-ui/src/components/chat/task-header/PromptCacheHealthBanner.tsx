import type { PromptCacheHealthSnapshot } from "@shared/PromptCacheHealth"
import { ActivityIcon } from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"

interface PromptCacheHealthBannerProps {
    health?: PromptCacheHealthSnapshot
}

/** Render Task-local prompt cache warming and warning state. */
export const PromptCacheHealthBanner: React.FC<PromptCacheHealthBannerProps> = ({ health }) => {
    const { t } = useUiTranslation()
    if (!health || health.status === "disabled" || health.status === "waiting" || health.status === "healthy") {
        return null
    }

    if (health.status === "warming") {
        if (health.warmingRound < 2) {
            return null
        }

        return (
            <Alert
                icon={<ActivityIcon className="size-3.5 shrink-0" />}
                key="warming"
                role="status"
                title={t("chatInput.cache.warming", { round: health.warmingRound, target: health.warmingTarget })}>
                <AlertDescription>{t("chatInput.cache.checking")}</AlertDescription>
            </Alert>
        )
    }

    const isNearContextWarning = health.warningReason === "near_context_low_hit_rate"
    const title = t(isNearContextWarning ? "chatInput.cache.low" : "chatInput.cache.notImproving")
    const description = isNearContextWarning
        ? t("chatInput.cache.lowDescription", { rate: formatHitRate(health.hitRate) })
        : t("chatInput.cache.notImprovingDescription")

    return (
        <Alert key={`warning-${health.warningReason ?? "unknown"}`} title={title} variant="warning">
            <AlertDescription>{description}</AlertDescription>
        </Alert>
    )
}

function formatHitRate(hitRate?: number): string {
    return `${hitRate ?? 0}%`
}
