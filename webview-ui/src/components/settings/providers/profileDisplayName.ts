import type { ApiProfile } from "@shared/proto/dline/profile"
import type { UiTranslator } from "@/i18n/messages"

/** Presentation only: never feed a translated fallback into persisted names or auto-naming. */
export function profileDisplayName(profile: Pick<ApiProfile, "name" | "provider" | "modelId">, t: UiTranslator): string {
    if (profile.name === "New Model" && !profile.provider) return t("settings.ui.newModel")
    return (
        profile.name ||
        (profile.provider && profile.modelId ? `${profile.provider}:${profile.modelId}` : t("settings.ui.unnamedProfile"))
    )
}
