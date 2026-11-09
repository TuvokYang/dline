import {
    isUiLanguagePreference,
    resolveUiLanguage,
    UI_LANGUAGE_LABELS,
    UI_LANGUAGES,
    type UiLanguagePreference,
} from "@shared/UiLanguage"
import { VSCodeDropdown, VSCodeOption } from "@vscode/webview-ui-toolkit/react"
import { useEffect, useRef, useState } from "react"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { ProfileField } from "./profile-ui"

interface UiLanguageSettingProps {
    preference: UiLanguagePreference
    hostDisplayLanguage?: string
    onPreferenceChange: (preference: UiLanguagePreference) => Promise<unknown>
}

/** Committed state is caller-owned; only in-flight intent and retry feedback are local. */
export default function UiLanguageSetting({ preference, hostDisplayLanguage, onPreferenceChange }: UiLanguageSettingProps) {
    const { t } = useUiTranslation()
    const [pending, setPending] = useState<UiLanguagePreference>()
    const [failure, setFailure] = useState<UiLanguagePreference>()
    const sequence = useRef(0)
    const activeRequest = useRef<{ value: UiLanguagePreference; acknowledged: boolean }>()

    useEffect(() => {
        const request = activeRequest.current
        if (request && request.value === preference) request.acknowledged = true
        setFailure((current) => (current === preference ? undefined : current))
    }, [preference])
    useEffect(
        () => () => {
            sequence.current++
        },
        [],
    )

    const save = async (value: UiLanguagePreference) => {
        const id = ++sequence.current
        const request = { value, acknowledged: false }
        activeRequest.current = request
        setPending(value)
        setFailure(undefined)
        try {
            await onPreferenceChange(value)
        } catch {
            // A rejected RPC can follow a durable commit; a matching publication wins.
            if (id === sequence.current && !request.acknowledged) setFailure(value)
        } finally {
            if (id === sequence.current) {
                activeRequest.current = undefined
                setPending(undefined)
            }
        }
    }

    const label = t("settings.general.uiLanguage.label")
    const hostLanguage = resolveUiLanguage("auto", hostDisplayLanguage)
    const selectedPreference = pending ?? preference
    const selectedLabel =
        selectedPreference === "auto" ? t("settings.general.uiLanguage.auto") : UI_LANGUAGE_LABELS[selectedPreference]
    return (
        <ProfileField
            aria-busy={pending !== undefined}
            description={
                <>
                    <span className="block leading-[inherit]" id="ui-language-description">
                        {t("settings.general.uiLanguage.description")}
                    </span>
                    <span className="block leading-[inherit]" id="ui-language-auto-description">
                        {t("settings.general.uiLanguage.followHost", { language: UI_LANGUAGE_LABELS[hostLanguage] })}
                    </span>
                    <span className="block leading-[inherit]" id="ui-language-coverage">
                        {t("settings.general.uiLanguage.coverage")}
                    </span>
                    {pending !== undefined && (
                        <span className="block leading-[inherit]" role="status">
                            {t("settings.general.uiLanguage.saving")}
                        </span>
                    )}
                </>
            }
            error={
                failure !== undefined && (
                    <>
                        {t("settings.general.uiLanguage.saveError")}{" "}
                        <button
                            className="underline cursor-pointer text-inherit leading-[inherit]"
                            onClick={() => void save(failure)}
                            type="button">
                            {t("settings.general.uiLanguage.retry")}
                        </button>
                    </>
                )
            }
            htmlFor="ui-language-dropdown"
            label={label}>
            <VSCodeDropdown
                aria-describedby="ui-language-description ui-language-auto-description ui-language-coverage"
                aria-label={label}
                className="w-full"
                id="ui-language-dropdown"
                onChange={(event) => {
                    const value = (event.target as HTMLSelectElement).value
                    if (!isUiLanguagePreference(value)) return
                    if (value === preference && pending === undefined && failure === undefined) return
                    void save(value)
                }}
                value={pending ?? preference}>
                <span slot="selected-value">{selectedLabel}</span>
                <VSCodeOption aria-label={t("settings.general.uiLanguage.auto")} value="auto">
                    {t("settings.general.uiLanguage.auto")}
                </VSCodeOption>
                {UI_LANGUAGES.map((value) => (
                    <VSCodeOption key={value} lang={value} value={value}>
                        {UI_LANGUAGE_LABELS[value]}
                    </VSCodeOption>
                ))}
            </VSCodeDropdown>
        </ProfileField>
    )
}
