import { Fragment, type ReactNode } from "react"

/** Render complete translated sentences with named React slots, never HTML. */
export function UiText({ text, slots }: { text: string; slots: Readonly<Record<string, ReactNode>> }) {
    const occurrences = new Map<string, number>()
    return text.split(/(\{[a-zA-Z][a-zA-Z0-9]*\})/g).map((part) => {
        const name = part.slice(1, -1)
        const isSlot = part.startsWith("{") && Object.hasOwn(slots, name)
        // Keep controls mounted when a translation reorders its named slots.
        const identity = isSlot ? `slot:${name}` : `text:${part}`
        const occurrence = occurrences.get(identity) ?? 0
        occurrences.set(identity, occurrence + 1)
        return <Fragment key={`${identity}:${occurrence}`}>{isSlot ? slots[name] : part}</Fragment>
    })
}
