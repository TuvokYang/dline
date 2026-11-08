import { ExportRuntimeTelemetryBundleRequest } from "@shared/proto/index.dline"
import { VSCodeButton, VSCodeCheckbox, VSCodeLink } from "@vscode/webview-ui-toolkit/react"
import { useState } from "react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { StateServiceClient } from "@/services/grpc-client"
import Section from "../Section"
import { SupportTelemetryStatus } from "../SupportTelemetryStatus"
import { updateSetting } from "../utils/settingsHandlers"

interface AboutSectionProps {
    version: string
    renderSectionHeader: (tabId: string) => JSX.Element | null
}

/**
 * What the last export attempt produced.
 *
 * The outcome is kept locally rather than in extension state because it
 * describes one user action, not a setting: it should disappear when the
 * settings view is closed, and nothing else in the app reacts to it.
 */
type ExportOutcome = { kind: "written"; path: string; sizeBytes: number } | { kind: "failed"; message: string }

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * One reporting consent.
 *
 * Consent must be given rather than merely left unanswered, so an undecided
 * user reads as unchecked and nothing is reported until the box is ticked.
 */
function ConsentCheckbox({
    label,
    description,
    setting,
    settingKey,
    organizationSetting,
    testId,
}: {
    label: string
    description: string
    setting: string
    settingKey: "usageReportingSetting" | "errorReportingSetting"
    organizationSetting: string | undefined
    testId: string
}) {
    const { t } = useUiTranslation()
    return (
        <div className="mt-2" data-consent={settingKey}>
            <Tooltip>
                <TooltipContent hidden={organizationSetting === undefined}>{t("settings.ui.managed")}</TooltipContent>
                <TooltipTrigger asChild>
                    <div className="flex items-center gap-2">
                        <VSCodeCheckbox
                            checked={setting === "enabled"}
                            data-testid={testId}
                            disabled={organizationSetting === "disabled"}
                            onChange={(e: any) => {
                                const checked = e.target.checked === true
                                updateSetting(settingKey, checked ? "enabled" : "disabled")
                            }}>
                            {label}
                        </VSCodeCheckbox>
                        {organizationSetting === "disabled" && <i className="codicon codicon-lock text-description text-sm" />}
                    </div>
                </TooltipTrigger>
            </Tooltip>
            {/* The description belongs to its own switch: each consent answers a
                different question, and a shared paragraph made the reader match
                sentences to checkboxes. */}
            <p className="text-sm mt-[2px] ml-6 text-description">{description}</p>
        </div>
    )
}

/**
 * The consents that govern what Dline records about a session.
 *
 * Usage and error reporting are asked separately because they answer different
 * questions: a user may want crashes investigated without agreeing to be
 * measured, or the reverse.
 *
 * They live beside the export button rather than in General settings because
 * the bundle only contains data these switches allowed to be collected, and a
 * user who turns error reporting off should see the export stop working right
 * here instead of hunting for the cause elsewhere.
 */
function ReportingConsent() {
    const { t } = useUiTranslation()
    const { usageReportingSetting, errorReportingSetting, remoteConfigSettings } = useExtensionState()

    return (
        <div>
            <h3 className="text-md font-semibold">{t("settings.ui.about.reporting")}</h3>

            <ConsentCheckbox
                description={t("settings.ui.about.usageHelp")}
                label={t("settings.ui.about.usage")}
                organizationSetting={remoteConfigSettings?.usageReportingSetting}
                setting={usageReportingSetting}
                settingKey="usageReportingSetting"
                testId="usage-reporting-setting-checkbox"
            />
            <ConsentCheckbox
                description={t("settings.ui.about.errorHelp")}
                label={t("settings.ui.about.error")}
                organizationSetting={remoteConfigSettings?.errorReportingSetting}
                setting={errorReportingSetting}
                settingKey="errorReportingSetting"
                testId="error-reporting-setting-checkbox"
            />

            {/* The privacy guarantee describes both consents, so it stays shared
                instead of being repeated under each switch. The destination is
                deliberately not named here: what matters to the reader is that
                reported data is aggregated, not where it is posted. */}
            <p className="text-sm mt-[8px] text-description">
                {t("settings.ui.about.privacyHelp")}{" "}
                <VSCodeLink
                    className="text-inherit"
                    href="https://docs.dline.cc/troubleshooting/telemetry/"
                    style={{ fontSize: "inherit", textDecoration: "underline" }}>
                    {t("settings.ui.about.telemetry")}
                </VSCodeLink>
                {" · "}
                <VSCodeLink
                    className="text-inherit"
                    href="https://docs.dline.cc/privacy/"
                    style={{ fontSize: "inherit", textDecoration: "underline" }}>
                    {t("settings.ui.about.privacy")}
                </VSCodeLink>
            </p>
        </div>
    )
}

/**
 * Writes the current session's diagnostic bundle into the Dline data directory.
 *
 * This sits next to the issue links because that is when it is needed: the
 * archive exists to be attached to a bug report, not to configure anything.
 *
 * Rendered only while error reporting is enabled. Runtime diagnostics start on
 * that consent alone, so with it off there is no session to export and the
 * button could only ever fail. Offering it anyway would advertise diagnostics
 * the extension is not permitted to collect.
 */
function DiagnosticBundleExport() {
    const { t } = useUiTranslation()
    const [isExporting, setIsExporting] = useState(false)
    const [outcome, setOutcome] = useState<ExportOutcome | null>(null)

    const onExport = async () => {
        setIsExporting(true)
        setOutcome(null)
        try {
            const response = await StateServiceClient.exportRuntimeTelemetryBundle(ExportRuntimeTelemetryBundleRequest.create({}))
            if (response.error) {
                setOutcome({ kind: "failed", message: response.error })
                return
            }
            setOutcome({ kind: "written", path: response.path, sizeBytes: Number(response.sizeBytes) })
        } catch (error) {
            setOutcome({ kind: "failed", message: error instanceof Error ? error.message : String(error) })
        } finally {
            setIsExporting(false)
        }
    }

    return (
        <div>
            <h3 className="text-md font-semibold">{t("settings.ui.about.diagnostics")}</h3>
            <p>{t("settings.ui.about.diagnosticsHelp")}</p>
            <VSCodeButton className="rounded-xs mt-2" disabled={isExporting} onClick={onExport}>
                {isExporting ? t("settings.ui.about.exporting") : t("settings.ui.about.export")}
            </VSCodeButton>
            {outcome?.kind === "written" && (
                <p className="text-sm mt-[5px] text-description" data-testid="diagnostic-bundle-written">
                    {t("settings.ui.about.saved", { path: outcome.path, size: formatBytes(outcome.sizeBytes) })}
                </p>
            )}
            {outcome?.kind === "failed" && (
                <p className="text-sm mt-[5px] text-error" data-testid="diagnostic-bundle-error">
                    {t("settings.ui.about.exportError", { diagnostic: outcome.message })}
                </p>
            )}
        </div>
    )
}
const AboutSection = ({ version, renderSectionHeader }: AboutSectionProps) => {
    const { t } = useUiTranslation()
    const { errorReportingSetting } = useExtensionState()
    // Mirrors the backend gate exactly: the runtime diagnostics pipeline follows
    // the error consent and starts only on "enabled", so an undecided user must
    // not be shown an export that has nothing to collect.
    const isDiagnosticsEnabled = errorReportingSetting === "enabled"

    return (
        <div>
            {renderSectionHeader("about")}
            <Section>
                <div className="flex px-4 flex-col gap-2">
                    <h2 className="text-lg font-semibold">Dline v{version}</h2>
                    <p>{t("settings.ui.about.description")}</p>

                    <h3 className="text-md font-semibold">{t("settings.ui.about.development")}</h3>
                    <p>
                        <VSCodeLink href="https://github.com/TuvokYang/dline">GitHub</VSCodeLink>
                        {" • "}
                        <VSCodeLink href="https://github.com/TuvokYang/dline/issues">{t("settings.ui.about.issues")}</VSCodeLink>
                        {" • "}
                        <VSCodeLink href="https://github.com/TuvokYang/dline/discussions/categories/feature-requests?discussions_q=is%3Aopen+category%3A%22Feature+Requests%22+sort%3Atop">
                            {" "}
                            {t("settings.ui.about.requests")}
                        </VSCodeLink>
                    </p>

                    <ReportingConsent />
                    <SupportTelemetryStatus />
                    {isDiagnosticsEnabled && <DiagnosticBundleExport />}
                </div>
            </Section>
        </div>
    )
}

export default AboutSection
