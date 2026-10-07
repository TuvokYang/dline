/**
 * Documentation images live in the repository's top-level `assets/docs/`
 * directory, next to the README and Marketplace media, instead of the site's
 * `public/` directory. Content references them through this import alias, for
 * example `![Alt text](@docs-assets/ui/chat-input-toolbar.png)`, so Astro's
 * image pipeline processes every image: it emits width, height and lazy
 * loading attributes and re-encodes PNG and animated GIF sources as WebP.
 */
import { fileURLToPath } from "node:url"

export const DOCS_ASSETS_ALIAS = "@docs-assets"

/** Absolute path of the repository's `assets/docs/` directory. */
export const DOCS_ASSETS_DIR = fileURLToPath(new URL("../../../assets/docs/", import.meta.url))
