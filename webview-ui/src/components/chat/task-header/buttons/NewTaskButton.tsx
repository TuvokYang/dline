import { XIcon } from "lucide-react"
import { useRef, useState } from "react"
import { buttonVariants } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { cn } from "@/lib/utils"

const NewTaskButton: React.FC<{
    onClick: () => Promise<void>
    className?: string
}> = ({ className, onClick }) => {
    const { t } = useUiTranslation()
    const closingRef = useRef(false)
    const [closing, setClosing] = useState(false)
    const [error, setError] = useState(false)

    const close = () => {
        if (closingRef.current) return
        closingRef.current = true
        setClosing(true)
        setError(false)
        void onClick()
            .catch(() => setError(true))
            .finally(() => {
                closingRef.current = false
                setClosing(false)
            })
    }

    return (
        <>
            <Tooltip>
                <TooltipContent side="left">{t(closing ? "chatInput.button.closing" : "chatInput.button.close")}</TooltipContent>
                <TooltipTrigger
                    aria-busy={closing}
                    aria-label={t("chatInput.button.close")}
                    className={cn(buttonVariants({ variant: "icon", size: "icon" }), "!overflow-visible !min-h-6", className)}
                    disabled={closing}
                    onClick={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        close()
                    }}>
                    <XIcon />
                </TooltipTrigger>
            </Tooltip>
            {error && (
                <span className="text-(--vscode-errorForeground) text-xs" role="alert">
                    {t("chatInput.button.closeError")}
                </span>
            )}
        </>
    )
}

export default NewTaskButton
