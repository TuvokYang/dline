/**
 * Documentation images live in the repository's top-level `assets/docs/`
 * directory, next to the README and Marketplace media, instead of the site's
 * `public/` directory. Content references them through this import alias, for
 * example `![Alt text](@docs-assets/ui/chat-input-toolbar.png)`, so Astro's
 * image pipeline processes every image: it emits width, height and lazy
 * loading attributes and re-encodes PNG and animated GIF sources as WebP.
 */
import path from "node:path"
import { fileURLToPath } from "node:url"

export const DOCS_ASSETS_ALIAS = "@docs-assets"

/** Absolute path of the repository's `assets/docs/` directory. */
export const DOCS_ASSETS_DIR = fileURLToPath(new URL("../../../assets/docs/", import.meta.url))

/**
 * Every captured image has a dark and a light edition. The demo recorder keeps
 * the dark edition under the plain name and stores the light one beside it with
 * this suffix before the extension (`DEMO_THEMES` in `src/test/e2e/demo/utils/demo-theme.ts`).
 */
export const LIGHT_EDITION_SUFFIX = "-light"

/**
 * The light edition of an `@docs-assets/...` reference, or undefined for any
 * other URL or one that is already a light edition.
 * @param {string} url
 * @returns {string | undefined}
 */
export function lightEditionOf(url) {
    if (!url.startsWith(`${DOCS_ASSETS_ALIAS}/`)) return undefined
    const match = /^(.*?)(\.[a-z\d]+)$/i.exec(url)
    if (!match || match[1].endsWith(LIGHT_EDITION_SUFFIX)) return undefined
    return `${match[1]}${LIGHT_EDITION_SUFFIX}${match[2]}`
}

/**
 * Absolute path of an `@docs-assets/...` reference.
 * @param {string} url
 * @returns {string}
 */
export function docsAssetPath(url) {
    return path.join(DOCS_ASSETS_DIR, ...url.slice(DOCS_ASSETS_ALIAS.length + 1).split("/"))
}
