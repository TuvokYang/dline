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
import { type UiMessageKey } from "@/i18n/messages"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"

interface ReportBugPreviewProps {
    data: string
    editable?: boolean
    selection?: readonly string[]
    onSelectionChange?: (selection: string[]) => void
}

type ContentField = keyof ReportBugDraft["content"]

const CONTENT_FIELDS: ReadonlyArray<{
    key: ContentField
    labelKey: Extract<UiMessageKey, `chatRows.reportBug.field.${string}`>
}> = [
    { key: "title", labelKey: "chatRows.reportBug.field.title" },
    { key: "whatHappened", labelKey: "chatRows.reportBug.field.whatHappened" },
    { key: "stepsToReproduce", labelKey: "chatRows.reportBug.field.stepsToReproduce" },
    { key: "apiRequestOutput", labelKey: "chatRows.reportBug.field.apiRequestOutput" },
    { key: "additionalContext", labelKey: "chatRows.reportBug.field.additionalContext" },
]

/**
 * The ReportBug draft prepared by the AI or the local fallback.
 *
 * The prepared fields stay read-only. When editable, the user's free-text details are
 * appended to Additional context and the diagnostics choice is recorded; both are
 * published as the interaction selection that "Open GitHub Issue" submits.
 */
const ReportBugPreview: React.FC<ReportBugPreviewProps> = ({ data, editable = false, selection, onSelectionChange }) => {
    const { t } = useUiTranslation()
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
                {t("chatRows.reportBug.unreadable")}
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
                {CONTENT_FIELDS.map(({ key, labelKey }) => (
                    <div key={key}>
                        <div className="mb-1 font-semibold">{t(labelKey)}</div>
                        <div className="whitespace-pre-wrap [overflow-wrap:anywhere]">{prepared.content[key]}</div>
                    </div>
                ))}

                {editable ? (
                    // The toolkit replaces aria-label with the slotted text on connect, so the
                    // slot is what names the box for assistive technology as well as on screen.
                    <VSCodeTextArea
                        aria-label={t("chatRows.reportBug.supplement")}
                        className="w-full"
                        onInput={(event) => updateSupplement((event.target as HTMLTextAreaElement).value)}
                        placeholder={t("chatRows.reportBug.supplementPlaceholder")}
                        resize="vertical"
                        rows={4}
                        value={supplement}>
                        <span className="font-semibold">{t("chatRows.reportBug.supplement")}</span>
                    </VSCodeTextArea>
                ) : null}

                <details>
                    <summary className="cursor-pointer font-semibold">{t("chatRows.reportBug.environmentSummary")}</summary>
                    <dl className="mt-2 grid gap-2 text-xs">
                        <div>
                            <dt className="font-semibold">{t("chatRows.reportBug.environment.providerAndModel")}</dt>
                            <dd>{draft.environment.providerAndModel}</dd>
                        </div>
                        <div>
                            <dt className="font-semibold">{t("chatRows.reportBug.environment.operatingSystem")}</dt>
                            <dd>{draft.environment.operatingSystem}</dd>
                        </div>
                        <div>
                            <dt className="font-semibold">{t("chatRows.reportBug.environment.systemInfo")}</dt>
                            <dd>{draft.environment.systemInfo}</dd>
                        </div>
                        <div>
                            <dt className="font-semibold">{t("chatRows.reportBug.environment.version")}</dt>
                            <dd>{draft.environment.dlineVersion}</dd>
                        </div>
                    </dl>
                </details>

                {/* Only an authorization issued before rendering offers the choice; it starts checked. */}
                {editable && draft.supportCode ? (
                    <div className="rounded border border-(--vscode-panel-border) p-2" data-testid="report-bug-telemetry">
                        <VSCodeCheckbox
                            checked={draft.temporaryTelemetryConsent}
                            onChange={(event) =>
                                publish({
                                    ...draft,
                                    temporaryTelemetryConsent: (event.target as HTMLInputElement).checked,
                                })
                            }>
                            {t("chatRows.reportBug.telemetry")}
                        </VSCodeCheckbox>
                        <p className="mt-1 text-xs text-description">
                            {t("chatRows.reportBug.telemetryNote", { supportCode: draft.supportCode })}
                        </p>
                    </div>
                ) : null}
            </div>
        </div>
    )
}

export default ReportBugPreview
