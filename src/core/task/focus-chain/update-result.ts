/** The accepted checklist, rather than a tool's success, decides progress effects. */
export type FocusChainUpdateResult =
    | { readonly kind: "applied" | "unchanged" | "ignored" }
    | { readonly kind: "rejected" | "failed"; readonly message: string }

/** User-visible facts only; model correction instructions stay in FocusChainPrompts. */
export const FocusChainDiagnostics = {
    loadingFailed: "The TODO list could not be loaded. No changes were saved.",
    persistenceFailed: "The TODO list could not be saved. The previous checklist is unchanged.",
    archiveFailed: "The TODO list was saved, but the previous checklist could not be archived.",
    ignoredCompletionProgress: "The completion tool ignored an unsupported TODO update. The checklist is unchanged.",
    skipOrderWarning: "TODO items were completed out of order. The update was accepted with a warning.",
    repeatedFailures: (count: number) =>
        `The TODO update failed after ${count} consecutive errors. The last saved checklist is unchanged.`,
} as const
