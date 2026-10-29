const SVG_NAMESPACE = "http://www.w3.org/2000/svg"
const VIEWBOX_PADDING = 8
const ACTIVE_ELEMENT_SELECTOR =
    "script, iframe, object, embed, audio, video, source, track, canvas, img, image, link, meta, base, form, input, button, textarea, select, option, animate, animateMotion, animateTransform, set"
const REFERENCE_ATTRIBUTES = new Set(["href", "xlink:href", "src", "srcset", "action", "formaction"])

const TEXT_STYLE_SELECTOR = "text, tspan, foreignObject, foreignObject *"
const TEXT_STYLE_PROPERTIES = [
    "align-items",
    "box-sizing",
    "color",
    "display",
    "fill",
    "font-family",
    "font-size",
    "font-stretch",
    "font-style",
    "font-variant",
    "font-weight",
    "justify-content",
    "letter-spacing",
    "line-height",
    "margin-bottom",
    "margin-left",
    "margin-right",
    "margin-top",
    "overflow",
    "overflow-wrap",
    "padding-bottom",
    "padding-left",
    "padding-right",
    "padding-top",
    "text-align",
    "text-anchor",
    "text-decoration",
    "text-transform",
    "white-space",
    "word-break",
    "word-spacing",
] as const

interface SvgViewBox {
    x: number
    y: number
    width: number
    height: number
}

export interface PreparedMermaidSvg {
    width: number
    height: number
    serializedSvg: string
}

export interface MermaidSvgExportOptions {
    backgroundColor: string
}

function parseViewBox(svgEl: SVGSVGElement): SvgViewBox {
    const rawViewBox = svgEl.getAttribute("viewBox")
    const values = rawViewBox
        ?.trim()
        .split(/[\s,]+/)
        .map(Number)

    if (values?.length === 4 && values.every(Number.isFinite) && values[2] > 0 && values[3] > 0) {
        return { x: values[0], y: values[1], width: values[2], height: values[3] }
    }

    const bounds = svgEl.getBoundingClientRect()
    const width = bounds.width || svgEl.clientWidth
    const height = bounds.height || svgEl.clientHeight
    if (width <= 0 || height <= 0) {
        throw new Error("Mermaid SVG has no measurable dimensions")
    }
    return { x: 0, y: 0, width, height }
}

function copyComputedTextStyles(sourceSvg: SVGSVGElement, targetSvg: SVGSVGElement): void {
    const sourceElements = Array.from(sourceSvg.querySelectorAll<SVGElement | HTMLElement>(TEXT_STYLE_SELECTOR))
    const targetElements = Array.from(targetSvg.querySelectorAll<SVGElement | HTMLElement>(TEXT_STYLE_SELECTOR))

    for (let index = 0; index < Math.min(sourceElements.length, targetElements.length); index += 1) {
        const computedStyle = window.getComputedStyle(sourceElements[index])
        const targetStyle = targetElements[index].style
        for (const property of TEXT_STYLE_PROPERTIES) {
            const value = computedStyle.getPropertyValue(property)
            if (value) {
                targetStyle.setProperty(property, value)
            }
        }
    }
}

function normalizeCssUrlTarget(rawTarget: string): string {
    const trimmed = rawTarget.trim()
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
        return trimmed.slice(1, -1).trim()
    }
    return trimmed
}

function sanitizeCss(css: string): string {
    return css
        .replace(/@import[\s\S]*?(?:;|$)/gi, "")
        .replace(/url\(([^)]*)\)/gi, (match, rawTarget: string) =>
            normalizeCssUrlTarget(rawTarget).startsWith("#") ? match : "none",
        )
        .replace(/(?:javascript|vbscript)\s*:/gi, "")
        .replace(/expression\s*\([^)]*\)/gi, "")
        .replace(/-moz-binding\s*:[^;]+;?/gi, "")
}

function unwrapLinks(svgClone: SVGSVGElement): void {
    for (const link of Array.from(svgClone.querySelectorAll("a"))) {
        const parent = link.parentNode
        if (!parent) continue
        while (link.firstChild) {
            parent.insertBefore(link.firstChild, link)
        }
        link.remove()
    }
}

function sanitizeSvg(svgClone: SVGSVGElement): void {
    for (const element of Array.from(svgClone.querySelectorAll(ACTIVE_ELEMENT_SELECTOR))) {
        element.remove()
    }
    unwrapLinks(svgClone)

    for (const styleElement of Array.from(svgClone.querySelectorAll("style"))) {
        styleElement.textContent = sanitizeCss(styleElement.textContent ?? "")
    }

    for (const element of [svgClone, ...Array.from(svgClone.querySelectorAll("*"))]) {
        for (const attribute of Array.from(element.attributes)) {
            const name = attribute.name.toLowerCase()
            const value = attribute.value.trim()
            if (name.startsWith("on") || (REFERENCE_ATTRIBUTES.has(name) && !value.startsWith("#"))) {
                element.removeAttribute(attribute.name)
                continue
            }
            if (name === "style" || /url\s*\(/i.test(value)) {
                const sanitizedValue = sanitizeCss(attribute.value)
                if (sanitizedValue.trim()) {
                    element.setAttribute(attribute.name, sanitizedValue)
                } else {
                    element.removeAttribute(attribute.name)
                }
            }
        }
    }
}

function addBackground(svgClone: SVGSVGElement, viewBox: SvgViewBox, backgroundColor: string): void {
    const background = document.createElementNS(SVG_NAMESPACE, "rect")
    background.setAttribute("data-mermaid-export-background", "true")
    background.setAttribute("x", String(viewBox.x))
    background.setAttribute("y", String(viewBox.y))
    background.setAttribute("width", String(viewBox.width))
    background.setAttribute("height", String(viewBox.height))
    background.setAttribute("fill", backgroundColor)
    svgClone.insertBefore(background, svgClone.firstChild)
}

export function prepareMermaidSvgForExport(svgEl: SVGSVGElement, options: MermaidSvgExportOptions): PreparedMermaidSvg {
    const viewBox = parseViewBox(svgEl)
    const paddedViewBox = {
        x: viewBox.x - VIEWBOX_PADDING,
        y: viewBox.y - VIEWBOX_PADDING,
        width: viewBox.width + VIEWBOX_PADDING * 2,
        height: viewBox.height + VIEWBOX_PADDING * 2,
    }
    const svgClone = svgEl.cloneNode(true) as SVGSVGElement

    copyComputedTextStyles(svgEl, svgClone)
    svgClone.setAttribute("viewBox", `${paddedViewBox.x} ${paddedViewBox.y} ${paddedViewBox.width} ${paddedViewBox.height}`)
    svgClone.setAttribute("width", String(Math.ceil(paddedViewBox.width)))
    svgClone.setAttribute("height", String(Math.ceil(paddedViewBox.height)))
    svgClone.style.removeProperty("max-width")
    svgClone.style.removeProperty("width")
    svgClone.style.removeProperty("height")
    if (!svgClone.getAttribute("style")?.trim()) {
        svgClone.removeAttribute("style")
    }
    addBackground(svgClone, paddedViewBox, options.backgroundColor)
    sanitizeSvg(svgClone)

    return {
        width: Math.ceil(paddedViewBox.width),
        height: Math.ceil(paddedViewBox.height),
        serializedSvg: new XMLSerializer().serializeToString(svgClone),
    }
}

function createSvgDataUrl(serializedSvg: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
            if (typeof reader.result === "string") {
                resolve(reader.result)
            } else {
                reject(new Error("Failed to encode the prepared Mermaid SVG"))
            }
        }
        reader.onerror = () => reject(new Error("Failed to encode the prepared Mermaid SVG"))
        reader.readAsDataURL(new Blob([serializedSvg], { type: "image/svg+xml" }))
    })
}

export async function svgToDataUrl(svgEl: SVGSVGElement, options: MermaidSvgExportOptions): Promise<string> {
    await document.fonts?.ready
    return createSvgDataUrl(prepareMermaidSvgForExport(svgEl, options).serializedSvg)
}
