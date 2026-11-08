import { EmptyRequest } from "@shared/proto/index.dline"
import { VSCodeButton, VSCodeLink } from "@vscode/webview-ui-toolkit/react"
import { useEffect, useRef, useState } from "react"
import { RemoteConfigToggle } from "@/components/account/RemoteConfigToggle"
import { useClineAuth } from "@/context/ClineAuthContext"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { StateServiceClient } from "@/services/grpc-client"
import Section from "../Section"

interface RemoteConfigSectionProps {
    renderSectionHeader: (tabId: string) => JSX.Element | null
}

function BaseRemoteConfigSection({ renderSectionHeader, children }: React.PropsWithChildren<RemoteConfigSectionProps>) {
    return (
        <div>
            {renderSectionHeader("remote-config")}
            <Section>{children}</Section>
        </div>
    )
}

const AUTOMATIC_DELAY_MS = 30000

function RefreshButton() {
    const { t } = useUiTranslation()
    const [isLoading, setIsLoading] = useState(false)
    const [retryIn, setRetryIn] = useState<number | null>(null)
    const intervalRef = useRef<NodeJS.Timeout>()

    useEffect(() => {
        return () => {
            if (intervalRef.current) {
                clearInterval(intervalRef.current)
            }
        }
    }, [])

    const onRefresh = () => {
        setIsLoading(true)
        StateServiceClient.refreshRemoteConfig(EmptyRequest.create()).finally(() => {
            setIsLoading(false)
            setRetryIn(AUTOMATIC_DELAY_MS / 1000)

            intervalRef.current = setInterval(() => {
                setRetryIn((old) => {
                    if (old && old > 0) return old - 1

                    intervalRef.current && clearInterval(intervalRef.current)
                    return null
                })
            }, 1000)
        })
    }

    return (
        <VSCodeButton
            className={`w-full rounded-xs ${isLoading ? "animate-pulse" : ""}`}
            disabled={isLoading || (retryIn !== null && retryIn > 0)}
            onClick={() => onRefresh()}>
            {retryIn && retryIn > 0 ? t("settings.ui.remote.retryIn", { seconds: retryIn }) : t("settings.ui.remote.refresh")}
        </VSCodeButton>
    )
}

interface SettingRowProps {
    label: string
    value: string | number | boolean | undefined | null
    isSecret?: boolean
}

function SettingRow({ label, value, isSecret }: SettingRowProps) {
    const { t } = useUiTranslation()
    const displayValue = (() => {
        if (value === undefined || value === null) {
            return <span className="text-description italic">{t("settings.ui.notConfigured")}</span>
        }
        if (typeof value === "boolean") {
            return value ? (
                <span className="text-green-500">{t("settings.ui.enabled")}</span>
            ) : (
                <span className="text-description">{t("settings.ui.disabled")}</span>
            )
        }
        if (isSecret && typeof value === "string" && value.length > 0) {
            return <span className="font-mono text-xs">{"•".repeat(Math.min(value.length, 20))}</span>
        }
        return <span className="font-mono text-xs break-all">{String(value)}</span>
    })()

    const isLongValue = typeof value === "string" && value.length > 25
    if (isLongValue) {
        return (
            <div className="flex flex-col gap-1 py-1.5 border-b border-vscode-widget-border last:border-b-0">
                <span className="text-description text-xs">{label}</span>
                <div className="pl-2 overflow-hidden text-right">{displayValue}</div>
            </div>
        )
    }

    return (
        <div className="flex justify-between items-center py-1.5 border-b border-vscode-widget-border last:border-b-0 gap-2">
            <span className="text-description text-xs shrink-0">{label}</span>
            <span className="text-right overflow-hidden text-ellipsis">{displayValue}</span>
        </div>
    )
}

interface TestButtonProps {
    label: string
    onClick: () => Promise<void>
    disabled?: boolean
    successMessage?: string
}

function TestButton({ label, onClick, disabled, successMessage }: TestButtonProps) {
    const { t } = useUiTranslation()
    const [isLoading, setIsLoading] = useState(false)
    const [result, setResult] = useState<{ success: boolean; diagnostic?: string } | null>(null)
    const timeoutRef = useRef<NodeJS.Timeout>()

    useEffect(() => {
        return () => {
            if (timeoutRef.current) {
                clearTimeout(timeoutRef.current)
            }
        }
    }, [])

    const handleClick = async () => {
        setIsLoading(true)
        setResult(null)
        try {
            await onClick()
            setResult({ success: true })
        } catch (error) {
            setResult({ success: false, diagnostic: error instanceof Error && error.message ? error.message : undefined })
        } finally {
            setIsLoading(false)
            timeoutRef.current = setTimeout(() => setResult(null), 5000)
        }
    }

    return (
        <div className="flex items-center gap-2">
            <VSCodeButton
                appearance="secondary"
                className={isLoading ? "animate-pulse" : ""}
                disabled={disabled || isLoading}
                onClick={handleClick}>
                {isLoading ? t("settings.ui.testing") : label}
            </VSCodeButton>
            {result && (
                <span className={`text-xs ${result.success ? "text-green-500" : "text-red-500"}`}>
                    {result.success
                        ? successMessage || t("settings.ui.success")
                        : result.diagnostic || t("settings.ui.remote.testFailed")}
                </span>
            )}
        </div>
    )
}

function OtelSettingsSection() {
    const { t } = useUiTranslation()
    const { remoteConfigSettings } = useExtensionState()

    const otelEnabled = remoteConfigSettings?.openTelemetryEnabled
    const hasOtelConfig =
        otelEnabled !== undefined ||
        remoteConfigSettings?.openTelemetryOtlpEndpoint !== undefined ||
        remoteConfigSettings?.openTelemetryMetricsExporter !== undefined ||
        remoteConfigSettings?.openTelemetryLogsExporter !== undefined

    if (!hasOtelConfig) {
        return null
    }

    const handleTestOtel = async () => {
        const response = await StateServiceClient.testOtelConnection(EmptyRequest.create({}))
        if (!response.success) {
            throw new Error(response.error)
        }
    }

    return (
        <div className="mb-4">
            <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                <i className="codicon codicon-pulse" />
                {t("settings.ui.remote.otel")}
            </h4>
            <div className="bg-vscode-textBlockQuote-background rounded p-3 mb-2">
                <SettingRow label={t("settings.ui.enabled")} value={otelEnabled} />
                <SettingRow
                    label={t("settings.ui.remote.metricsExporter")}
                    value={remoteConfigSettings?.openTelemetryMetricsExporter}
                />
                <SettingRow
                    label={t("settings.ui.remote.logsExporter")}
                    value={remoteConfigSettings?.openTelemetryLogsExporter}
                />
                <SettingRow label={t("settings.ui.remote.protocol")} value={remoteConfigSettings?.openTelemetryOtlpProtocol} />
                <SettingRow
                    label={t("settings.ui.remote.otelEndpoint")}
                    value={remoteConfigSettings?.openTelemetryOtlpEndpoint}
                />
                {remoteConfigSettings?.openTelemetryOtlpMetricsEndpoint && (
                    <SettingRow
                        label={t("settings.ui.remote.metricsEndpoint")}
                        value={remoteConfigSettings?.openTelemetryOtlpMetricsEndpoint}
                    />
                )}
                {remoteConfigSettings?.openTelemetryOtlpLogsEndpoint && (
                    <SettingRow
                        label={t("settings.ui.remote.logsEndpoint")}
                        value={remoteConfigSettings?.openTelemetryOtlpLogsEndpoint}
                    />
                )}
                {remoteConfigSettings?.openTelemetryOtlpHeaders && (
                    <SettingRow
                        label={t("settings.ui.remote.headers")}
                        value={t("settings.ui.remote.headerCount", {
                            count: Object.keys(remoteConfigSettings.openTelemetryOtlpHeaders).length,
                        })}
                    />
                )}
                {remoteConfigSettings?.openTelemetryMetricExportInterval && (
                    <SettingRow
                        label={t("settings.ui.remote.metricInterval")}
                        value={`${remoteConfigSettings.openTelemetryMetricExportInterval}ms`}
                    />
                )}
                {remoteConfigSettings?.openTelemetryOtlpInsecure !== undefined && (
                    <SettingRow
                        label={t("settings.ui.remote.insecure")}
                        value={remoteConfigSettings?.openTelemetryOtlpInsecure}
                    />
                )}
                {remoteConfigSettings?.openTelemetryLogBatchSize && (
                    <SettingRow
                        label={t("settings.ui.remote.logBatch")}
                        value={remoteConfigSettings?.openTelemetryLogBatchSize}
                    />
                )}
                {remoteConfigSettings?.openTelemetryLogBatchTimeout && (
                    <SettingRow
                        label={t("settings.ui.remote.logTimeout")}
                        value={`${remoteConfigSettings.openTelemetryLogBatchTimeout}ms`}
                    />
                )}
                {remoteConfigSettings?.openTelemetryLogMaxQueueSize && (
                    <SettingRow
                        label={t("settings.ui.remote.logQueue")}
                        value={remoteConfigSettings?.openTelemetryLogMaxQueueSize}
                    />
                )}
            </div>

            {otelEnabled && (
                <div className="flex gap-2 flex-wrap">
                    <TestButton
                        disabled={!remoteConfigSettings?.openTelemetryMetricsExporter}
                        label={t("settings.ui.test")}
                        onClick={handleTestOtel}
                        successMessage={t("settings.ui.remote.flushed")}
                    />
                </div>
            )}
        </div>
    )
}

function PromptUploadingSection() {
    const { t } = useUiTranslation()
    const { remoteConfigSettings } = useExtensionState()

    const blobStoreConfig = remoteConfigSettings?.blobStoreConfig
    if (!blobStoreConfig) {
        return null
    }

    const handleTestPromptUploading = async () => {
        const response = await StateServiceClient.testPromptUploading(EmptyRequest.create({}))
        if (!response.success) {
            throw new Error(response.error)
        }
    }

    return (
        <div className="mb-4">
            <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                <i className="codicon codicon-cloud-upload" />
                {t("settings.ui.remote.uploadConfig")}
            </h4>
            <div className="bg-vscode-textBlockQuote-background rounded p-3 mb-2">
                <SettingRow label={t("settings.ui.remote.storageType")} value={blobStoreConfig.adapterType?.toUpperCase()} />
                <SettingRow label={t("settings.ui.remote.bucket")} value={blobStoreConfig.bucket} />
                <SettingRow label={t("settings.ui.remote.region")} value={blobStoreConfig.region} />
                {blobStoreConfig.endpoint && (
                    <SettingRow label={t("settings.ui.remote.endpoint")} value={blobStoreConfig.endpoint} />
                )}
                {blobStoreConfig.accountId && (
                    <SettingRow label={t("settings.ui.remote.accountId")} value={blobStoreConfig.accountId} />
                )}
                <SettingRow isSecret label={t("settings.ui.remote.accessKey")} value={blobStoreConfig.accessKeyId} />
                <SettingRow isSecret label={t("settings.ui.remote.secretKey")} value={blobStoreConfig.secretAccessKey} />
                {blobStoreConfig.intervalMs && (
                    <SettingRow label={t("settings.ui.remote.syncInterval")} value={`${blobStoreConfig.intervalMs}ms`} />
                )}
                {blobStoreConfig.batchSize && (
                    <SettingRow label={t("settings.ui.remote.batchSize")} value={blobStoreConfig.batchSize} />
                )}
                {blobStoreConfig.maxRetries && (
                    <SettingRow label={t("settings.ui.remote.maxRetries")} value={blobStoreConfig.maxRetries} />
                )}
                {blobStoreConfig.maxQueueSize && (
                    <SettingRow label={t("settings.ui.remote.maxQueue")} value={blobStoreConfig.maxQueueSize} />
                )}
                <SettingRow label={t("settings.ui.remote.backfill")} value={blobStoreConfig.backfillEnabled} />
            </div>

            <TestButton label={t("settings.ui.remote.testUpload")} onClick={handleTestPromptUploading} />
        </div>
    )
}

export function RemoteConfigSection({ renderSectionHeader }: RemoteConfigSectionProps) {
    const { t } = useUiTranslation()
    const { remoteConfigSettings, optOutOfRemoteConfig } = useExtensionState()
    const { activeOrganization } = useClineAuth()

    if (optOutOfRemoteConfig) {
        return (
            <BaseRemoteConfigSection renderSectionHeader={renderSectionHeader}>
                <div className="flex flex-col justify-center gap-4">
                    <h3>{t("settings.ui.remote.optedOut")}</h3>

                    <RemoteConfigToggle activeOrganization={activeOrganization} />
                </div>
            </BaseRemoteConfigSection>
        )
    }

    if (!remoteConfigSettings || Object.keys(remoteConfigSettings).length === 0) {
        return (
            <BaseRemoteConfigSection renderSectionHeader={renderSectionHeader}>
                <div className="flex flex-col justify-center gap-4">
                    <h3>
                        {t("settings.ui.remote.unconfigured")}{" "}
                        <VSCodeLink href="https://app.dline.cc/dashboard/organization?tab=settings">
                            {t("settings.ui.remote.dashboard")}
                        </VSCodeLink>
                    </h3>

                    <RefreshButton />
                </div>
            </BaseRemoteConfigSection>
        )
    }

    return (
        <BaseRemoteConfigSection renderSectionHeader={renderSectionHeader}>
            <div className="flex flex-col gap-2">
                <p className="text-description text-xs mb-2">{t("settings.ui.remote.managed")}</p>

                <OtelSettingsSection />
                <PromptUploadingSection />

                <div className="mt-2">
                    <RefreshButton />
                </div>
            </div>
        </BaseRemoteConfigSection>
    )
}
