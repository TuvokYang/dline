import { type ReactElement, useId } from "react"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card"
import { TOOLTIP_OPEN_DELAY_MS } from "@/components/ui/tooltip"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"

interface TaskHoverProps {
    taskId?: string
    text?: string
    children: ReactElement
}

export function TaskHover({ taskId, text, children }: TaskHoverProps) {
    const { t } = useUiTranslation()
    const detailsId = useId()

    return (
        <HoverCard openDelay={TOOLTIP_OPEN_DELAY_MS}>
            <HoverCardTrigger aria-describedby={detailsId} aria-label={t("chatInput.header.details")} asChild tabIndex={0}>
                {children}
            </HoverCardTrigger>
            <HoverCardContent
                align="start"
                arrowClassName="hidden"
                className="ph-no-capture w-[min(28rem,calc(100vw-2rem))] max-h-[min(60vh,var(--radix-hover-card-content-available-height))] overflow-y-auto overscroll-contain text-xs"
                collisionPadding={8}
                id={detailsId}
                role="tooltip"
                side="bottom">
                <dl className="m-0 select-text">
                    <dt className="text-description mb-1">{t("chatInput.header.taskId")}</dt>
                    <dd className="m-0 font-mono whitespace-pre-wrap break-all">
                        {taskId || t("chatInput.header.idUnavailable")}
                    </dd>
                    <dt className="text-description mt-3 mb-1">{t("chatInput.header.fullText")}</dt>
                    <dd className="m-0 whitespace-pre-wrap break-words">{text}</dd>
                </dl>
            </HoverCardContent>
        </HoverCard>
    )
}
