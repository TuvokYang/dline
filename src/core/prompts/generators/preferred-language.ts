import { AUTO_LANGUAGE_PREFERENCE, getLanguageKey } from "@shared/Languages"
import { getPrompt, renderPrompt } from "../i18n"

/** Builds the model's response preference without coupling it to the UI locale. */
export function buildPreferredLanguageInstructions(preference: string | undefined): string {
    if (preference === AUTO_LANGUAGE_PREFERENCE) {
        return getPrompt("userInstructions", "automaticLanguage")
    }
    return renderPrompt("userInstructions", "fixedLanguage", { LANGUAGE: getLanguageKey(preference) })
}
