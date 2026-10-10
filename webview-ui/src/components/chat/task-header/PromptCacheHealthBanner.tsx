import type { PromptCacheHealthSnapshot } from "@shared/PromptCacheHealth"
import { ActivityIcon } from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"

interface PromptCacheHealthBannerProps {
    health?: PromptCacheHealthSnapshot
}

/** Render Task-local prompt cache warming and warning state. */
export const PromptCacheHealthBanner: React.FC<PromptCacheHealthBannerProps> = ({ health }) => {
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
                title={`Prompt cache warming (${health.warmingRound}/${health.warmingTarget})`}>
                <AlertDescription>Dline is checking whether cached input grows across requests.</AlertDescription>
            </Alert>
        )
    }

    const isNearContextWarning = health.warningReason === "near_context_low_hit_rate"
    const title = isNearContextWarning ? "Prompt cache is low near the context limit" : "Prompt cache is not improving"
    const description = isNearContextWarning
        ? `Expected at least 90% cached input near the context limit, but the latest request reported ${formatHitRate(health.hitRate)}. Check the active Profile, Provider, or proxy cache.`
        : "Cached input did not improve across three eligible requests. Check the active Profile, Provider, or proxy cache before the context grows further."

    return (
        <Alert key={`warning-${health.warningReason ?? "unknown"}`} title={title} variant="warning">
            <AlertDescription>{description}</AlertDescription>
        </Alert>
    )
}

function formatHitRate(hitRate?: number): string {
    return `${hitRate ?? 0}%`
}
