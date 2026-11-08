import type { ActiveInteractionView } from "@shared/ExtensionMessage"
import { useEffect, useState } from "react"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"

/** Display an absolute backend deadline; reaching zero never dispatches an intent. */
export function InteractionDeadline({ deadline }: { deadline: NonNullable<ActiveInteractionView["deadline"]> }) {
    const { t } = useUiTranslation()
    const [now, setNow] = useState(Date.now)
    useEffect(() => {
        setNow(Date.now())
        if (Date.now() >= deadline.deadlineAt) return
        const timer = window.setInterval(() => {
            const time = Date.now()
            setNow(time)
            if (time >= deadline.deadlineAt) window.clearInterval(timer)
        }, 1000)
        return () => window.clearInterval(timer)
    }, [deadline.deadlineAt])
    const seconds = Math.max(0, Math.ceil((deadline.deadlineAt - now) / 1000))
    return (
        <div aria-live="off" className="mb-1 text-xs text-description" role="timer">
            {t(deadline.kind === "ask" ? "chatInput.interaction.askDeadline" : "chatInput.interaction.commandDeadline", {
                time: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`,
            })}
        </div>
    )
}
