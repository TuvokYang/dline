import type { UiMessage } from "@shared/ExtensionMessage"
import { FilePlus2Icon } from "lucide-react"
import { useAnchorSelection } from "@/task-interaction/interaction-selection"
import { CHAT_ROW_HEADER_CLASSNAMES } from "./constants"
import ReportBugPreview from "./ReportBugPreview"

/**
 * The GitHub issue draft row.
 *
 * While its interaction is pending the row is the editing surface: the supplement
 * and consent the user enters here are what the footer's Open GitHub Issue submits.
 * The card is height-bound so a long draft scrolls inside the chat.
 */
export function ReportBugRow({ message }: { message: UiMessage }) {
    const selection = useAnchorSelection(message)
    const data = message.text ?? ""
    return (
        <div>
            <div className={CHAT_ROW_HEADER_CLASSNAMES}>
                <FilePlus2Icon className="size-2" />
                <span className="text-foreground font-bold">Dline wants to create a Github issue:</span>
            </div>
            <div className="max-h-[80vh] overflow-y-auto overscroll-x-contain" data-testid="report-bug-card">
                {selection ? (
                    <ReportBugPreview
                        data={data}
                        editable
                        key={message.ts}
                        onSelectionChange={selection.onChange}
                        selection={selection.values}
                    />
                ) : (
                    <ReportBugPreview data={data} />
                )}
            </div>
        </div>
    )
}
