import { VSCodeCheckbox, VSCodeDropdown, VSCodeOption, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import React, { type FormEvent, useEffect, useRef, useState } from "react"
import { LocalizedDropdown, LocalizedOption } from "@/components/common/LocalizedDropdown"
import { PlatformType } from "@/config/platform.config"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { usePlatform } from "@/context/PlatformContext"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { StateServiceClient } from "../../../services/grpc-client"
import Section from "../Section"
import TerminalCommandTimeoutSetting from "../TerminalCommandTimeoutSetting"
import TerminalHandoffSecondsSetting from "../TerminalHandoffSecondsSetting"
import TerminalOutputLineLimitSlider from "../TerminalOutputLineLimitSlider"
import { updateSetting } from "../utils/settingsHandlers"
import { useTextFieldHost } from "../utils/useTextFieldHost"

interface TerminalSettingsSectionProps {
    renderSectionHeader: (tabId: string) => JSX.Element | null
}

export const TerminalSettingsSection: React.FC<TerminalSettingsSectionProps> = ({ renderSectionHeader }) => {
    const { t } = useUiTranslation()
    const {
        shellIntegrationTimeout,
        terminalReuseEnabled,
        defaultTerminalProfile,
        availableTerminalProfiles,
        vscodeTerminalExecutionMode,
    } = useExtensionState()
    const platformConfig = usePlatform()
    const isVsCodePlatform = platformConfig.type === PlatformType.VSCODE

    const [inputValue, setInputValue] = useState((shellIntegrationTimeout / 1000).toString())
    const [inputError, setInputError] = useState<boolean | null>(null)
    const [isEditingShellIntegrationTimeoutValue, setIsEditingShellIntegrationTimeoutValue] = useState(false)
    const isEditingShellIntegrationTimeout = useRef(false)
    const shellIntegrationTimeoutHostProps = useTextFieldHost(
        t("settings.ui.terminal.integrationTimeout"),
        inputValue,
        !isEditingShellIntegrationTimeoutValue,
    )

    useEffect(() => {
        if (!isEditingShellIntegrationTimeout.current) {
            setInputValue((shellIntegrationTimeout / 1000).toString())
        }
    }, [shellIntegrationTimeout])

    const handleTimeoutChange = (event: Event) => {
        const target = event.target as HTMLInputElement
        const value = target.value

        if (!isEditingShellIntegrationTimeout.current) {
            isEditingShellIntegrationTimeout.current = true
            setIsEditingShellIntegrationTimeoutValue(true)
        }
        setInputValue(value)

        const seconds = Number.parseFloat(value)
        if (Number.isNaN(seconds) || seconds <= 0) {
            setInputError(true)
            return
        }

        setInputError(null)
    }

    const handleInputBlur = () => {
        isEditingShellIntegrationTimeout.current = false
        setIsEditingShellIntegrationTimeoutValue(false)
        const seconds = Number.parseFloat(inputValue)
        if (Number.isNaN(seconds) || seconds <= 0) {
            setInputValue((shellIntegrationTimeout / 1000).toString())
            setInputError(null)
            return
        }

        const timeoutMs = Math.round(seconds * 1000)
        setInputValue((timeoutMs / 1000).toString())
        void StateServiceClient.updateTerminalConnectionTimeout({ timeoutMs }).catch((error) => {
            console.error("Failed to update terminal connection timeout:", error)
        })
    }

    const handleTerminalReuseChange = (event: Event) => {
        const target = event.target as HTMLInputElement
        const checked = target.checked
        updateSetting("terminalReuseEnabled", checked)
    }

    const handleExecutionModeChange = (event: Event) => {
        const target = event.target as HTMLSelectElement
        const value = target.value === "backgroundExec" ? "backgroundExec" : "vscodeTerminal"
        updateSetting("vscodeTerminalExecutionMode", value)
    }

    // Use any to avoid type conflicts between Event and FormEvent
    const handleDefaultTerminalProfileChange = (event: any) => {
        const target = event.target as HTMLSelectElement
        const profileId = target.value

        // Save immediately using the consolidated updateSettings approach
        updateSetting("defaultTerminalProfile", profileId || "default")
    }

    const profilesToShow = availableTerminalProfiles

    return (
        <div>
            {renderSectionHeader("terminal")}
            <Section>
                <div className="mb-5" id="terminal-settings-section">
                    <div className="mb-4">
                        <label className="font-medium block mb-1" htmlFor="default-terminal-profile">
                            {t("settings.ui.terminal.profile")}
                        </label>
                        <VSCodeDropdown
                            className="w-full"
                            id="default-terminal-profile"
                            onChange={handleDefaultTerminalProfileChange}
                            value={defaultTerminalProfile || "default"}>
                            {profilesToShow.map((profile) => (
                                <VSCodeOption key={profile.id} title={profile.description} value={profile.id}>
                                    {profile.name}
                                </VSCodeOption>
                            ))}
                        </VSCodeDropdown>
                        <p className="text-xs text-(--vscode-descriptionForeground) mt-1">
                            {t("settings.ui.terminal.profileHelp")}
                        </p>
                    </div>
                    <TerminalCommandTimeoutSetting />
                    <TerminalHandoffSecondsSetting />

                    <div className="mb-4">
                        <div className="mb-2">
                            <label className="font-medium block mb-1" htmlFor="shell-integration-timeout">
                                {t("settings.ui.terminal.integrationTimeout")}
                            </label>
                            <div className="flex items-center">
                                <VSCodeTextField
                                    {...shellIntegrationTimeoutHostProps}
                                    className="w-full"
                                    id="shell-integration-timeout"
                                    onBlur={handleInputBlur}
                                    onFocus={() => {
                                        isEditingShellIntegrationTimeout.current = true
                                        setIsEditingShellIntegrationTimeoutValue(true)
                                    }}
                                    onInput={(event) => handleTimeoutChange(event as unknown as Event)}
                                    placeholder={t("settings.ui.terminal.enterTimeout")}
                                />
                            </div>
                            {inputError && (
                                <div className="text-(--vscode-errorForeground) text-xs mt-1">
                                    {t("settings.ui.terminal.positiveInvalid")}
                                </div>
                            )}
                        </div>
                        <p className="text-xs text-(--vscode-descriptionForeground)">
                            {t("settings.ui.terminal.integrationHelp")}
                        </p>
                    </div>

                    <div className="mb-4">
                        <div className="flex items-center mb-2">
                            <VSCodeCheckbox
                                checked={terminalReuseEnabled ?? true}
                                onChange={(event) => handleTerminalReuseChange(event as Event)}>
                                {t("settings.ui.terminal.reuse")}
                            </VSCodeCheckbox>
                        </div>
                        <p className="text-xs text-(--vscode-descriptionForeground)">{t("settings.ui.terminal.reuseHelp")}</p>
                    </div>
                    {isVsCodePlatform && (
                        <div className="mb-4">
                            <label className="font-medium block mb-1" htmlFor="terminal-execution-mode">
                                {t("settings.ui.terminal.executionMode")}
                            </label>
                            <LocalizedDropdown
                                className="w-full"
                                id="terminal-execution-mode"
                                onChange={(event: Event | FormEvent<HTMLElement>) => handleExecutionModeChange(event as Event)}
                                selectedLabel={
                                    (vscodeTerminalExecutionMode ?? "vscodeTerminal") === "vscodeTerminal"
                                        ? t("settings.ui.terminal.vscode")
                                        : vscodeTerminalExecutionMode === "backgroundExec"
                                          ? t("settings.ui.terminal.background")
                                          : undefined
                                }
                                value={vscodeTerminalExecutionMode ?? "vscodeTerminal"}>
                                <LocalizedOption label={t("settings.ui.terminal.vscode")} value="vscodeTerminal" />
                                <LocalizedOption label={t("settings.ui.terminal.background")} value="backgroundExec" />
                            </LocalizedDropdown>
                            <p className="text-xs text-[var(--vscode-descriptionForeground)] mt-1">
                                {t("settings.ui.terminal.executionHelp")}
                            </p>
                        </div>
                    )}
                    <TerminalOutputLineLimitSlider />
                    <div className="mt-5 p-3 bg-(--vscode-textBlockQuote-background) rounded border border-(--vscode-textBlockQuote-border)">
                        <p className="text-[13px] m-0">
                            <strong>{t("settings.ui.terminal.issues")}</strong>{" "}
                            <a
                                className="text-(--vscode-textLink-foreground) underline hover:no-underline"
                                href="https://docs.dline.cc/customization/terminal-environment/"
                                rel="noopener noreferrer"
                                target="_blank">
                                {t("settings.ui.terminal.quickFixes")}
                            </a>
                            {" · "}
                            <a
                                className="text-(--vscode-textLink-foreground) underline hover:no-underline"
                                href="https://docs.dline.cc/customization/terminal-environment/"
                                rel="noopener noreferrer"
                                target="_blank">
                                {t("settings.ui.terminal.guide")}
                            </a>
                        </p>
                    </div>
                </div>
            </Section>
        </div>
    )
}

export default TerminalSettingsSection
