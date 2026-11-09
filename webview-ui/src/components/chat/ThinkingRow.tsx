import { ChevronDownIcon, ChevronRightIcon } from "lucide-react"
import { memo, useId } from "react"
import { Button } from "@/components/ui/button"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { cn } from "@/lib/utils"
import { ThinkingContent } from "./ThinkingContent"
import { useThinkingScroll } from "./useThinkingScroll"

interface ThinkingRowProps {
    showTitle: boolean
    reasoningContent?: string
    isVisible: boolean
    isExpanded: boolean
    onToggle?: () => void
    title?: string
    isStreaming?: boolean
    showChevron?: boolean
}

export const ThinkingRow = memo(
    ({
        showTitle = false,
        reasoningContent,
        isVisible,
        isExpanded,
        onToggle,
        title,
        isStreaming = false,
        showChevron = true,
    }: ThinkingRowProps) => {
        const { t } = useUiTranslation()
        const contentId = useId()
        const { scrollRef, contentRef, onScroll, canScrollUp, canScrollDown } = useThinkingScroll(
            isVisible && isExpanded,
            isStreaming,
        )

        if (!isVisible) {
            return null
        }

        // Don't render anything if collapsed and no title (nothing to show)
        if (!isExpanded && !showTitle) {
            return null
        }

        return (
            <div className="ml-1 pl-0 mb-0 -mt-[2px]">
                {showTitle ? (
                    <Button
                        aria-controls={isExpanded ? contentId : undefined}
                        aria-expanded={showChevron ? isExpanded : undefined}
                        className={cn(
                            "inline-flex justify-baseline gap-0.5 text-left select-none px-0 py-0 my-0 h-auto min-h-0 w-full text-description overflow-visible",
                            {
                                "cursor-pointer": !!onToggle,
                                "cursor-default": !onToggle,
                            },
                        )}
                        onClick={onToggle}
                        size="icon"
                        variant="icon">
                        <span
                            className={cn("text-[13px] leading-[1.2]", {
                                "animate-shimmer bg-linear-90 from-foreground to-description bg-[length:200%_100%] bg-clip-text text-transparent":
                                    isStreaming,
                                "select-none": isStreaming,
                            })}>
                            {title ?? t("chatRows.thinking.title")}
                        </span>
                        {showChevron &&
                            (isExpanded ? (
                                <ChevronDownIcon className="!size-1 text-description" />
                            ) : (
                                <ChevronRightIcon className="!size-1 text-description" />
                            ))}
                    </Button>
                ) : null}

                {isExpanded && (
                    <div className="relative w-full min-w-0 text-left">
                        <div
                            aria-label={t("chatRows.thinking.content")}
                            className="max-h-[150px] overflow-y-auto text-description leading-normal break-words pl-0 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden [direction:ltr]"
                            id={contentId}
                            onScroll={onScroll}
                            ref={scrollRef}
                            role="region"
                            tabIndex={0}>
                            <div className="pb-2" ref={contentRef}>
                                <ThinkingContent content={reasoningContent} />
                            </div>
                        </div>
                        {canScrollUp && (
                            <div className="absolute top-0 left-0 right-0 h-6 pointer-events-none bg-gradient-to-b from-background to-transparent" />
                        )}
                        {canScrollDown && (
                            <div className="absolute bottom-0 left-0 right-0 h-6 pointer-events-none bg-gradient-to-t from-background to-transparent" />
                        )}
                    </div>
                )}
            </div>
        )
    },
)

ThinkingRow.displayName = "ThinkingRow"
