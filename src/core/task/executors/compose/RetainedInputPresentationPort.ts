export interface RetainedInputPresentation {
    readonly deliveryId: string
    readonly mode: "queued" | "steering"
    readonly entries: readonly { readonly entryId: string; readonly payloadRef: string }[]
}

export interface RetainedInputPresentationCommit {
    commit(): Promise<void>
}

/** Allocates causal row order before delivery and publishes only after durability. */
export interface RetainedInputPresentationPort {
    prepare(input: RetainedInputPresentation): Promise<RetainedInputPresentationCommit>
}
