import type { UiMessage } from "@shared/ExtensionMessage"
import { describeBrowserMessage } from "./browser-session-model"

/**
 * A browser row drawn without its session card.
 *
 * Grouping gives every browser row a session card, so this only guards other
 * callers of the generic row renderer: the row's payload holds a screenshot
 * data URL and must never reach text rendering.
 */
export function BrowserMessageSummary({ message }: { message: UiMessage }) {
    return (
        <div className="flex min-w-0 items-center gap-2.5" data-testid="browser-message-summary">
            <span className="codicon codicon-inspect shrink-0" />
            <span className="min-w-0 truncate">{describeBrowserMessage(message)}</span>
        </div>
    )
}
