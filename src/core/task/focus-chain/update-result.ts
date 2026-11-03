/** The accepted checklist, rather than a tool's success, decides progress effects. */
export type FocusChainUpdateResult =
    | { readonly kind: "applied" | "unchanged" | "ignored" }
    | { readonly kind: "rejected" | "failed"; readonly message: string }
