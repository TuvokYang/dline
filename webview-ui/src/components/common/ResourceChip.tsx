import type { ResourceInputNode, SemanticResourceRef } from "@shared/input-semantics/document"
import { createContext, useContext, useState } from "react"
import { describeResourceChip } from "@/components/chat/input/semantic-composer/chip-presentation"
import "@/components/chat/input/semantic-composer/composer-chip.css"

export interface ResourceChipProps {
    readonly node: ResourceInputNode
    readonly resource?: SemanticResourceRef
    readonly thumbnailUrl?: string
    /** Opens the resource; without it the chip only names the resource. */
    readonly onOpen?: () => void
}

const OPEN_HINT = "Click to open."

/** Image formats a sent row's display name can safely be read as. */
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"])

/**
 * A resource an input names, drawn as the chip the composer showed for it.
 *
 * Outside the composer a chip has nothing to remove or retry, so it carries
 * only the visual, the name and the format badge. A chip that can open its
 * resource is a button, so the action is reachable from the keyboard.
 */
export function ResourceChip({ node, resource, thumbnailUrl, onOpen }: ResourceChipProps): JSX.Element {
    const [thumbnailFailed, setThumbnailFailed] = useState(false)
    const chip = describeResourceChip(node, resource, onOpen ? OPEN_HINT : undefined)
    const className = `composer-chip composer-chip--${chip.tone}`
    const content = (
        <>
            {thumbnailUrl && !thumbnailFailed ? (
                // The label names the image, so the thumbnail is decorative; one that
                // cannot load gives way to the icon rather than a broken glyph.
                <img alt="" className="composer-chip__thumbnail" onError={() => setThumbnailFailed(true)} src={thumbnailUrl} />
            ) : (
                <span aria-hidden="true" className={`codicon codicon-${chip.icon} composer-chip__icon`} />
            )}
            <span className="composer-chip__label">{chip.label}</span>
            {chip.badge ? (
                <span aria-hidden="true" className="composer-chip__badge">
                    {chip.badge}
                </span>
            ) : null}
        </>
    )
    if (onOpen) {
        return (
            <button
                aria-label={chip.ariaLabel}
                className={className}
                data-resource-chip=""
                onClick={(event) => {
                    // The chip sits inside rows that react to clicks, such as a
                    // sent message that enters editing.
                    event.stopPropagation()
                    onOpen()
                }}
                title={chip.tooltip}
                type="button">
                {content}
            </button>
        )
    }
    return (
        <span className={`${className} composer-chip--static`} data-resource-chip="" title={chip.tooltip}>
            {content}
        </span>
    )
}

/** What a surface knows about the resource a chip link names, by the link's key. */
export type ResourceChipResolver = (key: string) => ResourceChipProps | undefined

/** Lets the surface around rendered Markdown resolve its resource links to full resources. */
export const ResourceChipResolverContext = createContext<ResourceChipResolver | undefined>(undefined)

/**
 * A resource node rebuilt from a display name, which is all a sent row records.
 *
 * Only the name's extension is known, so a name an image format ends in is read
 * as an image and everything else as a file; the chip then shows what the name
 * says rather than what the bytes were.
 */
function nodeFromDisplayName(key: string, displayName: string): ResourceInputNode {
    const dot = displayName.lastIndexOf(".")
    const extension = dot > 0 ? displayName.slice(dot + 1).toLowerCase() : ""
    return IMAGE_EXTENSIONS.has(extension)
        ? { kind: "image", entityId: key, resourceId: key, displayName }
        : { kind: "file", entityId: key, resourceId: key, fileOrigin: "uploaded_file", displayName }
}

/** The chip a resource link in a row's Markdown names, resolved by the surrounding surface when it can. */
export function LinkedResourceChip({ entityKey, displayName }: { entityKey: string; displayName: string }): JSX.Element {
    const resolve = useContext(ResourceChipResolverContext)
    const resolved = resolve?.(entityKey)
    return resolved ? <ResourceChip {...resolved} /> : <ResourceChip node={nodeFromDisplayName(entityKey, displayName)} />
}
