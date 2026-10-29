/**
 * Remark plugin that shows each documentation capture in the edition matching
 * the reader's color theme.
 *
 * Content references only the dark edition (`@docs-assets/ui/foo.gif`). When
 * the light edition (`foo-light.gif`) exists beside it, the image is followed
 * by that edition, and Starlight's theme utility classes keep exactly one of
 * the two visible: `light:sl-hidden` hides the dark edition under the light
 * theme and `dark:sl-hidden` hides the light edition under the dark theme. Both
 * stay ordinary Markdown images, so Astro's image pipeline still sizes,
 * lazy-loads and re-encodes each of them.
 */
import { existsSync } from "node:fs"
import { docsAssetPath, lightEditionOf } from "../data/assets.mjs"

const HIDDEN_UNDER_LIGHT = "light:sl-hidden"
const HIDDEN_UNDER_DARK = "dark:sl-hidden"

/**
 * @param {{ exists?: (filePath: string) => boolean }} [options] `exists` is replaceable for tests.
 */
export function remarkThemedImages(options = {}) {
    const exists = options.exists ?? existsSync
    return (/** @type {MdastNode} */ tree) => {
        pairImages(tree, (url) => {
            const light = lightEditionOf(url)
            return light && exists(docsAssetPath(light)) ? light : undefined
        })
    }
}

/**
 * @param {MdastNode} node
 * @param {(url: string) => string | undefined} lightEditionFor
 */
function pairImages(node, lightEditionFor) {
    const children = node.children
    if (!Array.isArray(children)) return
    for (let index = 0; index < children.length; index++) {
        const child = children[index]
        const light = child.type === "image" && typeof child.url === "string" ? lightEditionFor(child.url) : undefined
        if (!light) {
            pairImages(child, lightEditionFor)
            continue
        }
        withClass(child, HIDDEN_UNDER_LIGHT)
        const lightImage = withClass({ type: "image", url: light, alt: child.alt, title: child.title }, HIDDEN_UNDER_DARK)
        children.splice(index + 1, 0, lightImage)
        index++
    }
}

/**
 * @param {MdastNode} image
 * @param {string} className
 * @returns {MdastNode}
 */
function withClass(image, className) {
    const data = image.data ?? {}
    const properties = data.hProperties ?? {}
    const existing = Array.isArray(properties.className) ? properties.className : []
    image.data = { ...data, hProperties: { ...properties, className: [...existing, className] } }
    return image
}

/**
 * @typedef {{
 *   type: string,
 *   url?: string,
 *   alt?: string | null,
 *   title?: string | null,
 *   data?: { hProperties?: { className?: unknown } },
 *   children?: MdastNode[],
 * }} MdastNode
 */
