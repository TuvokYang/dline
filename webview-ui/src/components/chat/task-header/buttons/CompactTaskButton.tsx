import { FoldVerticalIcon } from "lucide-react"
import { buttonVariants } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { cn } from "@/lib/utils"

const CompactTaskButton: React.FC<{
    className?: string
    disabled?: boolean
    onClick: (e: React.MouseEvent<HTMLButtonElement>) => void
}> = ({ onClick, disabled, className }) => {
    const { t } = useUiTranslation()
    return (
        <Tooltip>
            <TooltipContent side="left">{t("chatInput.button.compact")}</TooltipContent>
            <TooltipTrigger
                aria-disabled={disabled}
                aria-label={t("chatInput.button.compactAria")}
                className={cn(
                    buttonVariants({ variant: "icon", size: "icon" }),
                    "!overflow-visible !min-h-6",
                    "[&_svg]:size-3",
                    disabled && "opacity-50 cursor-not-allowed pointer-events-none",
                    className,
                )}
                disabled={disabled}
                onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    if (disabled) return
                    onClick(e)
                }}>
                <FoldVerticalIcon />
            </TooltipTrigger>
        </Tooltip>
    )
}

export default CompactTaskButton
