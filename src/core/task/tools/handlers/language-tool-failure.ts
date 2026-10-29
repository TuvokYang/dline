import { getPrompt, renderPrompt } from "@core/prompts/i18n"
import { LanguageFailureKind } from "@/shared/proto/dline/host/language"

/** The subset of a language-service response needed to describe a failure. */
export interface LanguageFailure {
    failureKind: LanguageFailureKind
    hasLspSupport: boolean
    errorMessage: string
}

/**
 * Translate a language-service failure into an actionable message for the model.
 *
 * Each failure kind maps to its own guidance so that a bad path, an unindexed file,
 * and a host without LSP are never reported with the same text.
 *
 * @param promptModule i18n module of the calling tool ("findReferences" or "rename").
 * @param displayPath path shown to the user, already made workspace-relative.
 * @returns the message, or undefined when the response describes no failure.
 */
export function describeLanguageFailure(
    promptModule: "findReferences" | "rename",
    response: LanguageFailure,
    displayPath: string,
): string | undefined {
    switch (response.failureKind) {
        case LanguageFailureKind.LANGUAGE_FAILURE_KIND_INVALID_PATH:
            return renderPrompt(promptModule, "invalidPath", { PATH: displayPath })
        case LanguageFailureKind.LANGUAGE_FAILURE_KIND_OUTSIDE_WORKSPACE:
            return renderPrompt(promptModule, "outsideWorkspace", { PATH: displayPath })
        case LanguageFailureKind.LANGUAGE_FAILURE_KIND_NO_LANGUAGE_SUPPORT:
            return getPrompt(promptModule, "noLanguageSupport")
        case LanguageFailureKind.LANGUAGE_FAILURE_KIND_NO_LSP_HOST:
            return getPrompt(promptModule, "noLspSupport")
        case LanguageFailureKind.LANGUAGE_FAILURE_KIND_PROVIDER_ERROR:
            return renderPrompt(promptModule, "errorPrefix", { ERROR: response.errorMessage })
        default:
            // NONE or UNRECOGNIZED: fall back to the legacy flags so that hosts which
            // predate failure_kind still report missing LSP support correctly.
            if (!response.hasLspSupport) {
                return getPrompt(promptModule, "noLspSupport")
            }
            if (response.errorMessage) {
                return renderPrompt(promptModule, "errorPrefix", { ERROR: response.errorMessage })
            }
            return undefined
    }
}
