import { browserAdaptor } from "@mathjax/src/js/adaptors/browserAdaptor.js"
import { RegisterHTMLHandler } from "@mathjax/src/js/handlers/html.js"
import { TeX } from "@mathjax/src/js/input/tex.js"
import { mathjax } from "@mathjax/src/js/mathjax.js"
import { SVG } from "@mathjax/src/js/output/svg.js"

// MathJax v4 removed AllPackages, so every TeX package must be registered explicitly.
// Importing a Configuration module registers it with the TeX input jax.
import "@mathjax/src/js/input/tex/ams/AmsConfiguration.js"
import "@mathjax/src/js/input/tex/base/BaseConfiguration.js"
import "@mathjax/src/js/input/tex/begingroup/BegingroupConfiguration.js"
import "@mathjax/src/js/input/tex/boldsymbol/BoldsymbolConfiguration.js"
import "@mathjax/src/js/input/tex/braket/BraketConfiguration.js"
import "@mathjax/src/js/input/tex/color/ColorConfiguration.js"
import "@mathjax/src/js/input/tex/mhchem/MhchemConfiguration.js"
import "@mathjax/src/js/input/tex/newcommand/NewcommandConfiguration.js"
import "@mathjax/src/js/input/tex/noundefined/NoUndefinedConfiguration.js"

/**
 * TeX packages whose macros are announced to the model.
 *
 * Keep this list in sync with the capability declaration in the system prompt so
 * the model only emits macros we can actually typeset. `begingroup` is loaded
 * separately: it is infrastructure for per-formula isolation, not a macro set we
 * want the model to use directly.
 */
export const LATEX_TEX_PACKAGES = ["base", "ams", "newcommand", "noundefined", "boldsymbol", "braket", "mhchem", "color"] as const

/** Packages actually handed to the TeX input jax. */
const LOADED_TEX_PACKAGES = [...LATEX_TEX_PACKAGES, "begingroup"]

/**
 * Resets user-defined macros before each formula.
 *
 * `\newcommand`, `\renewcommand`, and `\def` mutate the input jax's dynamic
 * command tables, and those tables outlive a single conversion. Without this
 * prefix a macro defined in one chat message would silently change every later
 * formula — `\renewcommand{\alpha}{\beta}` really does keep rendering later
 * `\alpha` as a beta. The sandbox macro is provided by the `begingroup` package
 * and is listed in `newcommand`'s `protectedMacros`, so a formula cannot
 * redefine it.
 */
const SANDBOX_PREFIX = String.raw`\begingroupSandbox `

/** Fallback container width used when the host element has not been laid out yet. */
const FALLBACK_CONTAINER_WIDTH_PX = 320

/** Nominal font metrics handed to MathJax for line-breaking decisions. */
const EM_PX = 16
const EX_PX = 8

/**
 * Raised when TeX source cannot be parsed.
 *
 * MathJax swallows `TexError` inside `TeX.compile()` and substitutes an `merror`
 * node, which renders as an almost invisible box in SVG output. We opt out of
 * that behaviour so callers get a real rejection and can show the raw source.
 */
export class LatexRenderError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options)
        this.name = "LatexRenderError"
    }
}

interface MathDocumentLike {
    convertPromise(math: string, options?: Record<string, unknown>): Promise<unknown>
}

let cachedDocument: MathDocumentLike | undefined

/**
 * Returns the shared MathJax document.
 *
 * The engine is expensive to construct and holds a font cache, so it is created
 * once per webview session and reused by every formula block.
 */
function getMathDocument(): MathDocumentLike {
    if (!cachedDocument) {
        RegisterHTMLHandler(browserAdaptor())
        cachedDocument = mathjax.document("", {
            InputJax: new TeX({
                packages: LOADED_TEX_PACKAGES,
                // Turn MathJax's silent `merror` substitution into a real failure.
                formatError: (_jax: unknown, error: { message?: string }) => {
                    throw new LatexRenderError(error?.message ?? "Invalid TeX source", { cause: error })
                },
            }),
            // SVG output keeps glyphs as vector paths, so no web fonts are shipped and
            // the webview CSP font-src rules stay irrelevant to formula rendering.
            OutputJax: new SVG({ fontCache: "local" }),
        }) as unknown as MathDocumentLike
    }
    return cachedDocument
}

/**
 * Typesets TeX source into a detached DOM node.
 *
 * @param code Raw TeX source; must not be pre-escaped or wrapped in delimiters.
 * @param containerWidth Available width in pixels, used for line breaking.
 * @throws {LatexRenderError} When the TeX source cannot be parsed. Callers are
 *   expected to fall back to showing the original source rather than hiding the
 *   failure.
 */
export async function renderLatexToNode(code: string, containerWidth?: number): Promise<Node> {
    try {
        const node = await getMathDocument().convertPromise(SANDBOX_PREFIX + code, {
            display: true,
            em: EM_PX,
            ex: EX_PX,
            containerWidth: containerWidth && containerWidth > 0 ? containerWidth : FALLBACK_CONTAINER_WIDTH_PX,
        })
        return node as Node
    } catch (error) {
        // A failed conversion can abort inside the sandbox group, leaving the
        // input jax with an unbalanced group and a half-applied macro table. The
        // next formula would then fail with "Missing \begingroup" or silently
        // inherit definitions, so the engine is rebuilt instead of reused.
        cachedDocument = undefined
        throw error instanceof LatexRenderError
            ? error
            : new LatexRenderError(error instanceof Error ? error.message : "Invalid TeX source", { cause: error })
    }
}
