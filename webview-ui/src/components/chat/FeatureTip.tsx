import { LightbulbIcon } from "lucide-react"
import { memo, useCallback, useEffect, useRef, useState } from "react"
import { type UiMessageKey } from "@/i18n/messages"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { cn } from "@/lib/utils"

/** Product-owned tips; the message key keeps the rotating choice stable across a language switch. */
const FEATURE_TIP_KEYS = [
    "chatRows.tips.doubleCheck",
    "chatRows.tips.rules",
    "chatRows.tips.planMode",
    "chatRows.tips.mentions",
    "chatRows.tips.mcp",
    "chatRows.tips.checkpoints",
    "chatRows.tips.compact",
    "chatRows.tips.autoApprove",
    "chatRows.tips.quote",
    "chatRows.tips.images",
    "chatRows.tips.browser",
    "chatRows.tips.reportBug",
    "chatRows.tips.disable",
] as const satisfies readonly UiMessageKey[]

const SHOW_DELAY_MS = 2000
const CYCLE_INTERVAL_MS = 8000
const FADE_DURATION_MS = 300

/**
 * Shows rotating feature tips below the "Thinking..." indicator.
 * Appears after a brief delay and cycles through tips while Dline is thinking.
 */
export const FeatureTip = memo(() => {
    const { t } = useUiTranslation()
    const [isVisible, setIsVisible] = useState(false)
    const [hasFadedIn, setHasFadedIn] = useState(false)
    const [isFading, setIsFading] = useState(false)
    const [tipIndex, setTipIndex] = useState(() => Math.floor(Math.random() * FEATURE_TIP_KEYS.length))
    const cycleTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
    const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    const currentTip = t(FEATURE_TIP_KEYS[tipIndex])

    const advanceTip = useCallback(() => {
        setIsFading(true)
        fadeTimerRef.current = setTimeout(() => {
            setTipIndex((prev) => (prev + 1) % FEATURE_TIP_KEYS.length)
            setIsFading(false)
        }, FADE_DURATION_MS)
    }, [])

    useEffect(() => {
        showTimerRef.current = setTimeout(() => {
            setIsVisible(true)
            // Trigger fade-in on next frame so transition applies
            requestAnimationFrame(() => setHasFadedIn(true))
            cycleTimerRef.current = setInterval(advanceTip, CYCLE_INTERVAL_MS)
        }, SHOW_DELAY_MS)

        return () => {
            if (showTimerRef.current) {
                clearTimeout(showTimerRef.current)
            }
            if (cycleTimerRef.current) {
                clearInterval(cycleTimerRef.current)
            }
            if (fadeTimerRef.current) {
                clearTimeout(fadeTimerRef.current)
            }
        }
    }, [advanceTip])

    if (!isVisible) {
        return null
    }

    return (
        <div
            className={cn(
                "flex items-start gap-1.5 mt-2 ml-1 transition-opacity duration-300",
                !hasFadedIn || isFading ? "opacity-0" : "opacity-100",
            )}>
            <LightbulbIcon className="size-3 text-description shrink-0 mt-[1px]" />
            <span className="text-xs text-description leading-relaxed">
                <span className="font-medium">{t("chatRows.common.tip")}</span> {currentTip}
            </span>
        </div>
    )
})

FeatureTip.displayName = "FeatureTip"
