import type { ImageGenerationProfile } from "@shared/proto/dline/profile"
import { PlusIcon, Trash2Icon } from "lucide-react"
import { ApiKeyField } from "../common/ApiKeyField"
import { BaseUrlField } from "../common/BaseUrlField"

interface Props {
	profiles: ImageGenerationProfile[]
	onAdd: () => void
	onRemove: (id: string) => void
	onUpdate: (id: string, updates: Partial<ImageGenerationProfile>) => void
}

export function ImageGenerationProfileList({ profiles, onAdd, onRemove, onUpdate }: Props) {
	return (
		<div className="flex flex-col gap-3" data-testid="image-generation-profile-list">
			<div className="flex items-center justify-between">
				<div>
					<div className="text-sm font-medium">Image Generation Profiles</div>
					<div className="text-xs text-description">
						Independent image endpoints used by API Profile Image bindings.
					</div>
				</div>
				<button
					className="inline-flex min-h-7 items-center gap-1 rounded-xs border px-2 text-xs"
					onClick={onAdd}
					type="button">
					<PlusIcon size={14} /> Add image profile
				</button>
			</div>
			{profiles.map((profile) => (
				<div className="rounded-xs border border-editor-widget-border/50 p-3" key={profile.id}>
					<div className="mb-2 flex items-center gap-2">
						<input
							aria-label="Image profile name"
							className="min-h-7 flex-1 rounded-xs border border-input-border bg-input-background px-2 text-sm"
							onChange={(event) => onUpdate(profile.id, { name: event.target.value })}
							value={profile.name}
						/>
						<label className="flex items-center gap-1 text-xs">
							<input
								checked={profile.enabled}
								onChange={(event) => onUpdate(profile.id, { enabled: event.target.checked })}
								type="checkbox"
							/>
							Enabled
						</label>
						<button aria-label={`Delete ${profile.name}`} onClick={() => onRemove(profile.id)} type="button">
							<Trash2Icon size={14} />
						</button>
					</div>
					<label className="mb-2 flex flex-col gap-1 text-xs">
						Provider
						<select
							className="min-h-7 rounded-xs border border-input-border bg-input-background px-2 text-sm"
							onChange={(event) => onUpdate(profile.id, { provider: event.target.value })}
							value={profile.provider}>
							<option value="openai">OpenAI</option>
							<option value="gemini">Gemini</option>
						</select>
					</label>
					<BaseUrlField
						initialValue={profile.baseUrl}
						label="Custom image base URL"
						onChange={(value) => onUpdate(profile.id, { baseUrl: value || undefined })}
						placeholder={profile.provider === "gemini" ? "Default Gemini endpoint" : "Default OpenAI endpoint"}
					/>
					<ApiKeyField
						helpText="Stored keys are never returned to the UI. Enter a value to replace the stored key."
						initialValue={profile.apiKey}
						onChange={(value) => onUpdate(profile.id, { apiKey: value })}
						placeholder="Enter a new API key..."
						providerName={`${profile.name || "Image profile"} API`}
					/>
					<button
						className="mt-1 self-start text-xs text-description underline"
						onClick={() => onUpdate(profile.id, { apiKey: "" })}
						type="button">
						Clear stored API key
					</button>
				</div>
			))}
			{profiles.length === 0 ? (
				<div className="text-xs text-description">No independent image profiles configured.</div>
			) : null}
		</div>
	)
}
