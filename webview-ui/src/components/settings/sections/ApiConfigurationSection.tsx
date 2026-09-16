import { Mode } from "@shared/storage/types"
import { useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
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
		reloadProfiles,
	} = useApiProfiles()
	const imageProfiles = useImageGenerationProfiles()

	return (
		<div>
			{renderSectionHeader?.("api-config")}
			<Section>
				{!loaded && !error && <div className="py-3 text-sm text-description">Loading API profiles…</div>}
				{error && (
					<div className="py-3 text-sm text-errorForeground">
						<div>Failed to load API profiles. Existing profiles have not been replaced.</div>
						<button className="mt-2" onClick={() => void reloadProfiles()} type="button">
							Retry
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
						<div className="py-3 text-sm text-description">Loading image profiles…</div>
					) : null}
					{imageProfiles.error ? (
						<div className="py-3 text-sm text-errorForeground">
							<div>Failed to load image profiles.</div>
							<button className="mt-2" onClick={() => void imageProfiles.reload()} type="button">
								Retry
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
