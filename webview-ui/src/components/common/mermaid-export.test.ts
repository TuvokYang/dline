import { afterEach, describe, expect, it } from "vitest"
import { prepareMermaidSvgForExport, svgToDataUrl } from "./mermaid-export"

const SVG_NAMESPACE = "http://www.w3.org/2000/svg"
const XHTML_NAMESPACE = "http://www.w3.org/1999/xhtml"

function createMermaidSvg(): SVGSVGElement {
    const svg = document.createElementNS(SVG_NAMESPACE, "svg")
    svg.setAttribute("viewBox", "0 0 100 50")
    svg.setAttribute("width", "100%")
    svg.style.maxWidth = "100px"

    const foreignObject = document.createElementNS(SVG_NAMESPACE, "foreignObject")
    foreignObject.setAttribute("width", "100")
    foreignObject.setAttribute("height", "50")
    const label = document.createElementNS(XHTML_NAMESPACE, "div")
    label.className = "nodeLabel"
    label.textContent = "A complete node label"
    label.style.fontFamily = "Arial"
    label.style.fontSize = "13px"
    label.style.lineHeight = "18px"
    foreignObject.append(label)
    svg.append(foreignObject)
    document.body.append(svg)
    return svg
}

afterEach(() => {
    document.body.replaceChildren()
})

describe("prepareMermaidSvgForExport", () => {
    it("uses the padded viewBox size, adds a background, and freezes live label typography", () => {
        const svg = createMermaidSvg()
        const prepared = prepareMermaidSvgForExport(svg, { backgroundColor: "#1e1e1e" })
        const exportedDocument = new DOMParser().parseFromString(prepared.serializedSvg, "image/svg+xml")
        const exportedSvg = exportedDocument.documentElement
        const exportedLabelStyle = exportedDocument.querySelector(".nodeLabel")?.getAttribute("style") ?? ""

        expect(prepared).toMatchObject({ width: 116, height: 66 })
        expect(exportedSvg.getAttribute("viewBox")).toBe("-8 -8 116 66")
        expect(exportedSvg.getAttribute("width")).toBe("116")
        expect(exportedSvg.getAttribute("height")).toBe("66")
        expect(exportedSvg.getAttribute("style")).toBeNull()
        expect(exportedDocument.querySelector('[data-mermaid-export-background="true"]')?.getAttribute("fill")).toBe("#1e1e1e")
        expect(exportedLabelStyle).toContain("font-family: Arial")
        expect(exportedLabelStyle).toContain("font-size: 13px")
        expect(exportedLabelStyle).toContain("line-height: 18px")
    })

    it("removes active content and external references", () => {
        const svg = createMermaidSvg()
        svg.setAttribute("onload", "alert(1)")
        const script = document.createElementNS(SVG_NAMESPACE, "script")
        script.textContent = "alert(1)"
        const link = document.createElementNS(SVG_NAMESPACE, "a")
        link.setAttribute("href", "https://example.com")
        link.append(document.createElementNS(SVG_NAMESPACE, "path"))
        const externalFilter = document.createElementNS(SVG_NAMESPACE, "path")
        externalFilter.setAttribute("filter", "url(https://example.com/filter.svg#x)")
        svg.append(script, link, externalFilter)

        const serializedSvg = prepareMermaidSvgForExport(svg, { backgroundColor: "#1e1e1e" }).serializedSvg
        expect(serializedSvg).not.toMatch(/<script|onload=|<a\b|https:\/\//i)
    })
})

describe("svgToDataUrl", () => {
    it("encodes the prepared SVG without rasterizing it", async () => {
        const dataUrl = await svgToDataUrl(createMermaidSvg(), { backgroundColor: "#1e1e1e" })
        expect(dataUrl).toMatch(/^data:image\/svg\+xml;base64,/)
        expect(atob(dataUrl.split(",")[1])).toContain("<svg")
    })
})
