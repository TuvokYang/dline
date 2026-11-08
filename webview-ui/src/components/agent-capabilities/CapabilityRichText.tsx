import React from "react"

/** Named React slots in a complete translated sentence. No HTML or payload parsing. */
export function CapabilityRichText<K extends string>({
    parts,
    render,
}: {
    parts: readonly { name: K; node: React.ReactNode }[]
    render: (slot: (name: K) => string) => string
}) {
    const slot = (name: K) => `\uFFFC${name}\uFFFC`
    let nodes: React.ReactNode[] = [render(slot)]
    for (const part of parts) {
        nodes = nodes.flatMap<React.ReactNode>((node) => {
            if (typeof node !== "string") return [node]
            return node
                .split(slot(part.name))
                .flatMap((text, index) =>
                    index === 0 ? [text] : [<React.Fragment key={`${part.name}-${index}`}>{part.node}</React.Fragment>, text],
                )
        })
    }
    return <>{nodes}</>
}
