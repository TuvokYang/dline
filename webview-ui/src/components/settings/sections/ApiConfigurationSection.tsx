import { Mode } from "@shared/storage/types"
import { useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { ImageGenerationProfileList } from "../providers/ImageGenerationProfileList"
import ProviderProfileList from "../providers/ProviderProfileList"
import { useApiProfiles } from "../providers/useApiProfiles"
import { useImageGenerationProfiles } from "../providers/useImageGenerationProfiles"
import Section from "../Section"

interface ApiConfigurationSectionProps {
    renderSectionHeader?: (tabId: string) => JSX.Element | null
}

/**
 * API Configuration section — replaced old provider selector + conditional rendering
 * with a unified ProviderProfileList that reuses existing Provider components.
 */
const ApiConfigurationSection = ({ renderSectionHeader }: ApiConfigurationSectionProps) => {
    const { t } = useUiTranslation()
    const { mode, imageGenerationEnabled } = useExtensionState()
    const [currentTab] = useState<Mode>(mode)
    const {
        profiles,
        expandedId,
        editMode,
        setEditMode,
        addProfile,
        updateProfile,
        reorderProfiles,
        removeProfile,
        toggleExpand,
        providerOptions,
        loaded,
        error,
        saveError,
        reloadProfiles,
    } = useApiProfiles()
    const imageProfiles = useImageGenerationProfiles()

    return (
        <div>
            {renderSectionHeader?.("api-config")}
            <Section>
                {saveError && (
                    <div className="py-3 text-sm text-errorForeground" role="alert">
                        {t("settings.ui.api.saveError")}
                    </div>
                )}
                {!loaded && !error && <div className="py-3 text-sm text-description">{t("settings.ui.api.loading")}</div>}
                {error && (
                    <div className="py-3 text-sm text-errorForeground">
                        <div>{t("settings.ui.api.loadError")}</div>
                        <button className="mt-2" onClick={() => void reloadProfiles()} type="button">
                            {t("settings.ui.retry")}
                        </button>
                    </div>
                )}
                {loaded && !error && (
                    <ProviderProfileList
                        currentMode={currentTab}
                        editMode={editMode}
                        expandedId={expandedId}
                        imageGenerationEnabled={imageGenerationEnabled === true}
                        imageProfiles={imageProfiles.profiles}
                        onAddProfile={addProfile}
                        onDeleteProfile={removeProfile}
                        onReorderProfiles={reorderProfiles}
                        onToggleEditMode={() => setEditMode(!editMode)}
                        onToggleExpand={toggleExpand}
                        onUpdateProfile={updateProfile}
                        profiles={profiles}
                        providerOptions={providerOptions}
                    />
                )}
            </Section>
            {imageGenerationEnabled ? (
                <Section>
                    {!imageProfiles.loaded && !imageProfiles.error ? (
                        <div className="py-3 text-sm text-description">{t("settings.ui.api.imageLoading")}</div>
                    ) : null}
                    {imageProfiles.error ? (
                        <div className="py-3 text-sm text-errorForeground">
                            <div>{t("settings.ui.api.imageLoadError")}</div>
                            <button className="mt-2" onClick={() => void imageProfiles.reload()} type="button">
                                {t("settings.ui.retry")}
                            </button>
                        </div>
                    ) : null}
                    {imageProfiles.loaded && !imageProfiles.error ? (
                        <ImageGenerationProfileList
                            onAdd={imageProfiles.addProfile}
                            onRemove={imageProfiles.removeProfile}
                            onUpdate={imageProfiles.updateProfile}
                            profiles={imageProfiles.profiles}
                        />
                    ) : null}
                </Section>
            ) : null}
        </div>
    )
}

export default ApiConfigurationSection
