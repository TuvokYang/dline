import {
    parseReportBugDraft,
    type ReportBugDraft,
    reportBugDraftFromSelection,
    reportBugDraftSelection,
} from "@shared/report-bug"
import { VSCodeCheckbox, VSCodeTextArea, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import React from "react"

interface ReportBugPreviewProps {
    data: string
    editable?: boolean
    selection?: readonly string[]
    onSelectionChange?: (selection: string[]) => void
}

type ContentField = keyof ReportBugDraft["content"]

const CONTENT_FIELDS: ReadonlyArray<{
    key: ContentField
    label: string
    multiline?: boolean
}> = [
    { key: "title", label: "Title" },
    { key: "whatHappened", label: "What happened?", multiline: true },
    { key: "stepsToReproduce", label: "Steps to reproduce", multiline: true },
    { key: "apiRequestOutput", label: "Relevant API request output", multiline: true },
    { key: "additionalContext", label: "Additional context", multiline: true },
]

/** The single editable ReportBug draft shown by AI and local fallback interactions. */
const ReportBugPreview: React.FC<ReportBugPreviewProps> = ({ data, editable = false, selection, onSelectionChange }) => {
    const draft = React.useMemo(() => reportBugDraftFromSelection(selection) ?? parseReportBugDraft(data), [data, selection])

    const publish = React.useCallback(
        (next: ReportBugDraft) => onSelectionChange?.(reportBugDraftSelection(next)),
        [onSelectionChange],
    )

    if (!draft) {
        return (
            <div className="bg-badge-background/50 text-badge-foreground rounded-xs p-3" role="alert">
                This bug report preview could not be read.
            </div>
        )
    }

    const updateContent = (key: ContentField, value: string) => publish({ ...draft, content: { ...draft.content, [key]: value } })

    return (
        <div className="bg-badge-background/50 text-badge-foreground rounded-xs p-3" data-testid="report-bug-preview">
            <div className="space-y-3 text-sm">
                {CONTENT_FIELDS.map(({ key, label, multiline }) => (
                    <label className="block" key={key}>
                        <span className="mb-1 block font-semibold">{label}</span>
                        {editable ? (
                            multiline ? (
                                <VSCodeTextArea
                                    aria-label={label}
                                    className="w-full"
                                    onInput={(event) => updateContent(key, (event.target as HTMLTextAreaElement).value)}
                                    resize="vertical"
                                    rows={key === "apiRequestOutput" ? 5 : 3}
                                    value={draft.content[key]}
                                />
                            ) : (
                                <VSCodeTextField
                                    aria-label={label}
                                    className="w-full"
                                    onInput={(event) => updateContent(key, (event.target as HTMLInputElement).value)}
                                    value={draft.content[key]}
                                />
                            )
                        ) : (
                            <div className="whitespace-pre-wrap [overflow-wrap:anywhere]">{draft.content[key]}</div>
                        )}
                    </label>
                ))}

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
