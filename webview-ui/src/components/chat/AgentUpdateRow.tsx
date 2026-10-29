import { memo } from "react"
import { CopyButton } from "@/components/common/CopyButton"
import MarkdownBlock from "@/components/common/MarkdownBlock"
import { cn } from "@/lib/utils"

/** The two non-turn-ending updates the model posts while it keeps working. */
export type AgentUpdateKind = "reply" | "phase_report"

const UPDATE_PRESENTATION: Record<AgentUpdateKind, { icon: string; label: string; testId: string }> = {
    reply: { icon: "comment", label: "Reply", testId: "working-respond-row" },
    phase_report: { icon: "milestone", label: "Phase report", testId: "phase-report-row" },
}

/**
 * Long content scrolls inside the row instead of pushing the conversation away.
 * The standard scrollbar properties are set on the element itself so the thumb
 * follows the theme's slider color in every theme, without arrow buttons.
 */
const BODY_CLASSNAMES =
    "max-h-[40vh] overflow-y-auto [scrollbar-width:thin] [scrollbar-color:var(--vscode-scrollbarSlider-background,rgba(121,121,121,0.4))_transparent]"

interface AgentUpdateRowProps {
    kind: AgentUpdateKind
    text: string
}

/**
 * A reply or a phase report: a thin outline over a faint fill, one quiet header line.
 *
 * Codicons are font glyphs drawn at their native 14px and the label uses the
 * description color, so the header stays crisp. A phase report sets its header
 * apart with a divider, which is what tells it apart from a reply at a glance.
 */
const AgentUpdateRow = memo(({ kind, text }: AgentUpdateRowProps) => {
    const presentation = UPDATE_PRESENTATION[kind]
    return (
        <div
            className="group relative rounded-sm border border-editor-widget-border/70 bg-toolbar-hover/30 px-2.5 py-2"
            data-testid={presentation.testId}>
            <div className="absolute top-1 right-1 z-10 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                <CopyButton textToCopy={text} />
            </div>
            <div className="flex h-4 items-center gap-1.5 text-[12px] leading-4 text-description">
                <span aria-hidden="true" className={`codicon codicon-${presentation.icon} text-[14px]! leading-none!`} />
                <span className="font-medium">{presentation.label}</span>
            </div>
            <div
                className={cn(
                    BODY_CLASSNAMES,
                    kind === "phase_report" ? "mt-2 border-t border-editor-widget-border/50 pt-2" : "mt-1.5",
                )}>
                <div className="wrap-anywhere [&_hr]:opacity-20 [&_p:last-child]:mb-0">
                    <MarkdownBlock markdown={text} />
                </div>
            </div>
        </div>
    )
})

AgentUpdateRow.displayName = "AgentUpdateRow"

export default AgentUpdateRow
