import type { ResourceInputNode, SemanticResourceRef } from "./document"

/**
 * One admitted piece of a submission, in the order the user placed it.
 *
 * Admission resolves commands and mentions to text but keeps every resource as
 * its own part, so the provider projection can put an image or a file exactly
 * where it was inserted instead of after all the text.
 *
 * This is a durable contract: admission produces it, the task journal stores it
 * and the provider projection reads it, so none of those layers depends on the
 * others to know its shape.
 */
export type AdmittedInputPart = AdmittedTextPart | AdmittedResourcePart

export interface AdmittedTextPart {
    readonly kind: "text"
    readonly text: string
}

export interface AdmittedResourcePart {
    readonly kind: "resource"
    readonly entityId: string
    readonly nodeKind: ResourceInputNode["kind"]
    /** The reference admission verified; materialization reads these exact bytes. */
    readonly ref: SemanticResourceRef
    /** The name the user saw; never a local path. */
    readonly displayName: string
}

/** True when the parts carry at least one resource, i.e. text alone cannot represent them. */
export function hasResourceParts(parts: readonly AdmittedInputPart[]): boolean {
    return parts.some((part) => part.kind === "resource")
}

/** Append a part, merging adjacent text so the projection has no empty seams. */
export function appendAdmittedPart(parts: AdmittedInputPart[], part: AdmittedInputPart): void {
    if (part.kind === "text") {
        if (part.text.length === 0) return
        const last = parts.at(-1)
        if (last?.kind === "text") {
            parts[parts.length - 1] = { kind: "text", text: last.text + part.text }
            return
        }
    }
    parts.push(part)
}

/** Trim leading whitespace of the first text part and trailing whitespace of the last one. */
export function trimAdmittedParts(parts: readonly AdmittedInputPart[]): AdmittedInputPart[] {
    const trimmed = [...parts]
    const first = trimmed[0]
    if (first?.kind === "text") trimmed[0] = { kind: "text", text: first.text.trimStart() }
    const lastIndex = trimmed.length - 1
    const last = trimmed[lastIndex]
    if (last?.kind === "text") trimmed[lastIndex] = { kind: "text", text: last.text.trimEnd() }
    return trimmed.filter((part) => part.kind !== "text" || part.text.length > 0)
}
