// @vitest-environment jsdom

/**
 * Contract tests for the shared MathJax engine wrapper.
 *
 * These run against the real engine (no mocks) because the behaviour under test
 * is exactly the boundary between MathJax's defaults and our failure contract:
 * MathJax normally swallows TeX syntax errors and returns an `merror` node, which
 * would render as a blank block in the webview.
 */

import { describe, expect, it } from "vitest"
import { LATEX_TEX_PACKAGES, LatexRenderError, renderLatexToNode } from "../latex-engine"

const GAUSSIAN_INTEGRAL = String.raw`\int_{0}^{\infty} e^{-x^2}\,dx = \frac{\sqrt{\pi}}{2}`
const COLORED_FORMULA = String.raw`\textcolor{teal}{x^2}`
const UNKNOWN_MACRO = String.raw`\thisMacroDoesNotExist{x}`
const UNBALANCED_BRACES = String.raw`\frac{1}{`
const UNKNOWN_ENVIRONMENT = String.raw`\begin{notAnEnvironment} x \end{notAnEnvironment}`
const BOLDSYMBOL_FORMULA = String.raw`\boldsymbol{x} + \boldsymbol{\beta}`
const BRAKET_FORMULA = String.raw`\braket{\phi | \psi}`
const MHCHEM_FORMULA = String.raw`\ce{H2O}`
const AMS_ENVIRONMENT = String.raw`\begin{align} a &= b \\ c &= d \end{align}`
const NEWCOMMAND_FORMULA = String.raw`\newcommand{\myVec}[1]{\mathbf{#1}}\myVec{x}`

/**
 * One formula per NewCM dynamic font file the engine bundles.
 *
 * These glyphs are not part of the font's static data: MathJax requests the
 * file on first use. When the request cannot be served, the first missing
 * glyph degrades to a system-font `<text>` fallback and any later glyph from
 * the same file rejects the whole formula. Each entry is a macro from the
 * announced TeX packages that was observed to need exactly that file.
 */
const DYNAMIC_FONT_FORMULAS: ReadonlyArray<readonly [file: string, source: string]> = [
    ["monospace", String.raw`\mathtt{x} + \texttt{abc}`],
    ["sans-serif", String.raw`\mathsf{x}`],
    ["double-struck", String.raw`x \in \mathbb{R}`],
    ["fraktur", String.raw`\mathfrak{g} + \Re z`],
    ["script", String.raw`\mathscr{L} + \ell`],
    ["calligraphic", String.raw`\mathcal{ABCDEFGHIJKLMNOPQRSTUVWXYZ}`],
    ["latin", String.raw`\text{café}`],
    ["math", String.raw`a \triangleq b \perp c`],
    ["arrows", String.raw`a \leadsto b`],
    ["greek", String.raw`\digamma`],
    ["shapes", String.raw`\checkmark`],
    ["symbols-b-i", String.raw`\circledR`],
]

/**
 * Cyrillic glyphs live in a dynamic font file the engine deliberately does not
 * bundle. Two distinct letters make the rejection independent of whether an
 * earlier formula already consumed MathJax's single-glyph text fallback.
 */
const UNBUNDLED_FONT_FORMULA = String.raw`\text{ЖЯ}`

/** MathJax emits `<text>` only for glyphs it could not take from the font. */
const SYSTEM_FONT_FALLBACK = "<text"

/** Glyph ids MathJax emits for greek letters, used to detect macro leakage. */
const ALPHA_GLYPH = "1D6FC"
const BETA_GLYPH = "1D6FD"

function glyphIdsOf(html: string): string[] {
    return [...html.matchAll(/MJX-\d+-NCM-I-([0-9A-F]+)/g)].map((match) => match[1])
}

function outerHtmlOf(node: Node): string {
    return (node as unknown as { outerHTML?: string }).outerHTML ?? ""
}

describe("renderLatexToNode", () => {
    it("declares the TeX packages announced to the model", () => {
        expect([...LATEX_TEX_PACKAGES]).toEqual([
            "base",
            "ams",
            "newcommand",
            "noundefined",
            "boldsymbol",
            "braket",
            "mhchem",
            "color",
        ])
    })

    it("typesets a display formula into an SVG node", async () => {
        const node = await renderLatexToNode(GAUSSIAN_INTEGRAL, 320)

        expect(outerHtmlOf(node)).toContain("<svg")
    })

    it("keeps the color package active so formulas can be tinted", async () => {
        const node = await renderLatexToNode(COLORED_FORMULA, 320)

        expect(outerHtmlOf(node).toLowerCase()).toContain("teal")
    })

    it("still renders unknown macros through the noundefined package", async () => {
        const node = await renderLatexToNode(UNKNOWN_MACRO, 320)

        expect(outerHtmlOf(node)).toContain("<svg")
    })

    it("rejects malformed TeX instead of resolving with a blank merror node", async () => {
        await expect(renderLatexToNode(UNBALANCED_BRACES, 320)).rejects.toBeInstanceOf(LatexRenderError)
    })

    it("rejects an unknown environment", async () => {
        await expect(renderLatexToNode(UNKNOWN_ENVIRONMENT, 320)).rejects.toBeInstanceOf(LatexRenderError)
    })

    it("stays usable after a rejection", async () => {
        await expect(renderLatexToNode(UNBALANCED_BRACES, 320)).rejects.toBeInstanceOf(LatexRenderError)
        const node = await renderLatexToNode(GAUSSIAN_INTEGRAL, 320)

        expect(outerHtmlOf(node)).toContain("<svg")
    })

    it.each([
        ["ams", AMS_ENVIRONMENT],
        ["newcommand", NEWCOMMAND_FORMULA],
        ["boldsymbol", BOLDSYMBOL_FORMULA],
        ["braket", BRAKET_FORMULA],
        ["mhchem", MHCHEM_FORMULA],
    ])("typesets a formula that needs the %s package", async (_package, source) => {
        const node = await renderLatexToNode(source, 320)

        expect(outerHtmlOf(node)).toContain("<svg")
    })

    it.each(DYNAMIC_FONT_FORMULAS)("typesets glyphs from the bundled %s dynamic font file", async (_file, source) => {
        const html = outerHtmlOf(await renderLatexToNode(source, 320))

        expect(html).toContain("<svg")
        expect(html).not.toContain("merror")
        expect(html).not.toContain(SYSTEM_FONT_FALLBACK)
    })

    it("rejects glyphs whose dynamic font file is not bundled, then keeps typesetting", async () => {
        await expect(renderLatexToNode(UNBUNDLED_FONT_FORMULA, 320)).rejects.toBeInstanceOf(LatexRenderError)
        const node = await renderLatexToNode(String.raw`\mathtt{x}`, 320)

        expect(outerHtmlOf(node)).toContain("<svg")
    })

    it("does not leak a macro defined by one formula into the next", async () => {
        await renderLatexToNode(String.raw`\newcommand{\leakedMacro}{42}`, 320)
        const node = await renderLatexToNode(String.raw`\leakedMacro`, 320)

        // noundefined keeps the unknown macro visible as literal text instead of
        // silently expanding a definition that belonged to another chat message.
        expect(outerHtmlOf(node)).toContain("leakedMacro")
    })

    it("does not let one formula redefine a builtin macro for later formulas", async () => {
        const before = glyphIdsOf(outerHtmlOf(await renderLatexToNode(String.raw`\alpha`, 320)))
        expect(before).toContain(ALPHA_GLYPH)

        await renderLatexToNode(String.raw`\renewcommand{\alpha}{\beta}`, 320)
        const after = glyphIdsOf(outerHtmlOf(await renderLatexToNode(String.raw`\alpha`, 320)))

        expect(after).toContain(ALPHA_GLYPH)
        expect(after).not.toContain(BETA_GLYPH)
    })

    it("does not leak a macro defined by a formula that then failed", async () => {
        await expect(renderLatexToNode(String.raw`\newcommand{\halfDefined}{7}\frac{1}{`, 320)).rejects.toBeInstanceOf(
            LatexRenderError,
        )
        const node = await renderLatexToNode(String.raw`\halfDefined`, 320)

        expect(outerHtmlOf(node)).toContain("halfDefined")
    })
})
