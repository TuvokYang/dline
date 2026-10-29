import { mathjax } from "@mathjax/src/js/mathjax.js"

/**
 * Prefix MathJax prepends to every NewCM SVG dynamic font file it requests.
 *
 * Mirrors `dynamicPrefix` in `@mathjax/mathjax-newcm-font/js/svg.js`.
 */
const NEWCM_SVG_DYNAMIC_PREFIX = "@mathjax/mathjax-newcm-font/js/svg/dynamic/"

type FontFileLoader = () => Promise<unknown>

/**
 * NewCM dynamic font files bundled into the webview, keyed by MathJax file name.
 *
 * The NewCM font keeps every glyph outside its core set — `\mathtt`, `\mathsf`,
 * `\mathbb`, `\mathfrak`, `\mathscr`, `\ell`, `\perp`, `\checkmark`, accented
 * text letters, ... — in separate files that MathJax requests on first use.
 * This set is exactly what the macros of the announced TeX packages
 * (`LATEX_TEX_PACKAGES`) were observed to request. Other scripts such as
 * Cyrillic or Hebrew are left out on purpose to bound the bundle size;
 * formulas that need them keep failing and `LatexBlock` shows the raw source.
 *
 * Every entry is a literal `import()` so the bundler sees and includes the
 * file; with `inlineDynamicImports` they end up in the main webview bundle.
 */
const BUNDLED_FONT_FILES: ReadonlyMap<string, FontFileLoader> = new Map<string, FontFileLoader>([
    ["arrows", () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/arrows.js")],
    ["calligraphic", () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/calligraphic.js")],
    ["double-struck", () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/double-struck.js")],
    ["fraktur", () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/fraktur.js")],
    ["greek", () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/greek.js")],
    ["latin", () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/latin.js")],
    ["math", () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/math.js")],
    ["monospace", () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/monospace.js")],
    ["sans-serif", () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/sans-serif.js")],
    ["script", () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/script.js")],
    ["shapes", () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/shapes.js")],
    ["symbols-b-i", () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/symbols-b-i.js")],
])

/** Extracts the NewCM SVG dynamic font file name from a MathJax load request. */
function dynamicFontFileName(request: string): string | undefined {
    if (!request.startsWith(NEWCM_SVG_DYNAMIC_PREFIX)) {
        return undefined
    }
    return request.slice(NEWCM_SVG_DYNAMIC_PREFIX.length).replace(/\.js$/, "")
}

/**
 * Serves a MathJax load request from the bundled font files.
 *
 * Resolves once the requested module has registered its glyph data. Rejects
 * for any request outside the bundled set; MathJax turns that into a failed
 * conversion instead of fetching code at runtime.
 */
function loadBundledFontFile(request: string): Promise<unknown> {
    const fileName = dynamicFontFileName(request)
    const load = fileName === undefined ? undefined : BUNDLED_FONT_FILES.get(fileName)
    if (!load) {
        return Promise.reject(new Error(`MathJax requested "${request}", which is not bundled with the webview`))
    }
    return load()
}

/**
 * Routes MathJax's on-demand loading to the bundled font files.
 *
 * Without a loader MathJax cannot fetch any dynamic font file in the webview,
 * so every formula needing one of those glyphs fails. `mathjax.asyncLoad` is
 * process-wide configuration; it must be installed before the first
 * conversion and is safe to install repeatedly.
 */
export function installBundledFontLoader(): void {
    mathjax.asyncLoad = loadBundledFontFile
}
