import {
    appendReportBugSupplement,
    parseReportBugDraft,
    type ReportBugDraft,
    reportBugDraftFromSelection,
    reportBugDraftSelection,
    reportBugSupplement,
} from "@shared/report-bug"
import { VSCodeCheckbox, VSCodeTextArea } from "@vscode/webview-ui-toolkit/react"
import React from "react"

interface ReportBugPreviewProps {
    data: string
    editable?: boolean
    selection?: readonly string[]
    onSelectionChange?: (selection: string[]) => void
}

type ContentField = keyof ReportBugDraft["content"]

const CONTENT_FIELDS: ReadonlyArray<{ key: ContentField; label: string }> = [
    { key: "title", label: "Title" },
    { key: "whatHappened", label: "What happened?" },
    { key: "stepsToReproduce", label: "Steps to reproduce" },
    { key: "apiRequestOutput", label: "Relevant API request output" },
    { key: "additionalContext", label: "Additional context" },
]

const SUPPLEMENT_LABEL = "Additional details"

/**
 * The ReportBug draft prepared by the AI or the local fallback.
 *
 * The prepared fields stay read-only. When editable, the user's free-text details are
 * appended to Additional context and the diagnostics choice is recorded; both are
 * published as the interaction selection that "Open GitHub Issue" submits.
 */
const ReportBugPreview: React.FC<ReportBugPreviewProps> = ({ data, editable = false, selection, onSelectionChange }) => {
    const prepared = React.useMemo(() => parseReportBugDraft(data), [data])
    const draft = React.useMemo(() => reportBugDraftFromSelection(selection) ?? prepared, [prepared, selection])
    // Raw text keeps trailing whitespace that the published draft trims while the user types.
    // Reading the selection back lets a remounted card show the supplement it would submit.
    const [supplement, setSupplement] = React.useState(() =>
        prepared && draft ? reportBugSupplement(prepared.content, draft.content) : "",
    )

    if (!prepared || !draft) {
        return (
            <div className="bg-badge-background/50 text-badge-foreground rounded-xs p-3" role="alert">
                This bug report preview could not be read.
            </div>
        )
    }

    const publish = (next: ReportBugDraft) => onSelectionChange?.(reportBugDraftSelection(next))
    const updateSupplement = (text: string) => {
        setSupplement(text)
        publish({ ...draft, content: appendReportBugSupplement(prepared.content, text) })
    }

    return (
        <div className="bg-badge-background/50 text-badge-foreground rounded-xs p-3" data-testid="report-bug-preview">
            <div className="space-y-3 text-sm">
                {CONTENT_FIELDS.map(({ key, label }) => (
                    <div key={key}>
                        <div className="mb-1 font-semibold">{label}</div>
                        <div className="whitespace-pre-wrap [overflow-wrap:anywhere]">{prepared.content[key]}</div>
                    </div>
                ))}

                {editable ? (
                    // The toolkit replaces aria-label with the slotted text on connect, so the
                    // slot is what names the box for assistive technology as well as on screen.
                    <VSCodeTextArea
                        aria-label={SUPPLEMENT_LABEL}
                        className="w-full"
                        onInput={(event) => updateSupplement((event.target as HTMLTextAreaElement).value)}
                        placeholder="Add anything the report above is missing"
                        resize="vertical"
                        rows={4}
                        value={supplement}>
                        <span className="font-semibold">{SUPPLEMENT_LABEL}</span>
                    </VSCodeTextArea>
                ) : null}

                <details>
                    <summary className="cursor-pointer font-semibold">Environment included in the issue</summary>
                    <dl className="mt-2 grid gap-2 text-xs">
                        <div>
                            <dt className="font-semibold">Provider / model</dt>
                            <dd>{draft.environment.providerAndModel}</dd>
                        </div>
                        <div>
                            <dt className="font-semibold">Operating system</dt>
                            <dd>{draft.environment.operatingSystem}</dd>
                        </div>
                        <div>
                            <dt className="font-semibold">System info</dt>
                            <dd>{draft.environment.systemInfo}</dd>
                        </div>
                        <div>
                            <dt className="font-semibold">Dline version</dt>
                            <dd>{draft.environment.dlineVersion}</dd>
                        </div>
                    </dl>
                </details>

                {editable ? (
                    <div className="rounded border border-(--vscode-panel-border) p-2">
                        <VSCodeCheckbox
                            checked={draft.temporaryTelemetryConsent}
                            onChange={(event) =>
                                publish({
                                    ...draft,
                                    temporaryTelemetryConsent: (event.target as HTMLInputElement).checked,
                                })
                            }>
                            Temporarily share high-density diagnostics for this issue
                        </VSCodeCheckbox>
                        <p className="mt-1 text-xs text-description">
                            Optional. If unchecked, Dline only opens the normal GitHub issue form and creates no support
                            authorization or diagnostic polling.
                        </p>
                    </div>
                ) : null}
            </div>
        </div>
    )
}

export default ReportBugPreview
