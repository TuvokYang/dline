import MarkdownBlock from "@/components/common/MarkdownBlock"
import { cn } from "@/lib/utils"

export type UserInputMarkdownVariant = "direct" | "queued-history" | "queued-pending"

const HEIGHT_CLASS: Record<UserInputMarkdownVariant, string> = {
    direct: "max-h-[min(30vh,320px)]",
    "queued-history": "max-h-[min(30vh,320px)]",
    "queued-pending": "max-h-[min(20vh,180px)]",
}

interface UserInputMarkdownBodyProps {
    markdown?: string
    variant: UserInputMarkdownVariant
    testId: string
}

/** Shared Markdown body with a bounded, non-propagating vertical scroll surface. */
export function UserInputMarkdownBody({ markdown, variant, testId }: UserInputMarkdownBodyProps) {
    return (
        <div
            className={cn(
                "wrap-anywhere overflow-x-hidden overflow-y-auto overscroll-contain [scrollbar-gutter:stable] [&_p:last-child]:mb-0",
                HEIGHT_CLASS[variant],
            )}
            data-testid={testId}>
            <MarkdownBlock markdown={markdown} />
        </div>
    )
}
