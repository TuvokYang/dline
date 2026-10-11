import { describeChip } from "./chip-presentation"
import {
    type ComposerAtom,
    type ComposerRange,
    type ComposerSegment,
    type ComposerSelection,
    flatTextOf,
    segmentLength,
} from "./model"

/**
 * The DOM projection of a composer draft and the mapping between DOM points
 * and flat model offsets.
 *
 * The editor never lets the browser edit this DOM, except for the text an IME
 * composes; after every change it is rebuilt from the model. Each child of the
 * root covers a known flat range, recorded in `data-start`:
 * - a text piece holds exactly one text node;
 * - an atom is a non-editable chip one unit long;
 * - an anchor is a zero-width text node after an atom with no text behind it,
 *   so the caret has a real text position there, and covers no model unit;
 * - a filler line break makes a trailing newline or an empty draft visible.
 */

export const COMPOSER_DOM = {
    text: "data-composer-text",
    atom: "data-composer-atom",
    anchor: "data-composer-anchor",
    filler: "data-composer-filler",
    start: "data-start",
    plain: "data-plain",
    entityId: "data-entity-id",
    chipAction: "data-chip-action",
} as const

const ZERO_WIDTH_SPACE = "\u200B"

export type ChipAction = "open" | "remove" | "retry"

/** A highlighted flat range of text, such as a typed command the catalog recognizes. */
export interface ComposerDecoration {
    readonly range: ComposerRange
    readonly className: string
}

export interface ComposerRenderOptions {
    readonly decorations?: readonly ComposerDecoration[]
    /** Atoms the current selection covers whole; they are drawn as selected. */
    readonly selectedAtomIds?: ReadonlySet<string>
}

/** Atom chips are immutable per atom object, so an unchanged atom keeps its element and thumbnail. */
const chipCache = new WeakMap<ComposerAtom, HTMLElement>()

function element<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    attributes: Record<string, string>,
    ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag)
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value)
    node.append(...children)
    return node
}

function chipElement(atom: ComposerAtom): HTMLElement {
    const cached = chipCache.get(atom)
    if (cached) return cached
    const chip = describeChip(atom)
    const visual =
        atom.kind === "resource" && atom.nodeKind === "image" && atom.status === "ready" && atom.previewUrl
            ? element("img", { class: "composer-chip__thumbnail", src: atom.previewUrl, alt: `Thumbnail ${atom.displayName}` })
            : element("span", {
                  class: `codicon codicon-${chip.icon}${chip.busy ? " codicon-modifier-spin" : ""} composer-chip__icon`,
                  "aria-hidden": "true",
              })
    const parts: Node[] = [visual, element("span", { class: "composer-chip__label" }, chip.label)]
    if (chip.badge) parts.push(element("span", { class: "composer-chip__badge", "aria-hidden": "true" }, chip.badge))
    if (atom.kind === "resource" && atom.status === "failed" && atom.error?.retryable) {
        parts.push(
            element("span", {
                class: "codicon codicon-refresh composer-chip__action",
                role: "button",
                [COMPOSER_DOM.chipAction]: "retry",
                "aria-label": `Retry ${atom.displayName}`,
                title: "Retry",
            }),
        )
    }
    parts.push(
        element("span", {
            class: "codicon codicon-close composer-chip__action",
            role: "button",
            [COMPOSER_DOM.chipAction]: "remove",
            "aria-label": `Remove ${chip.label}`,
            title: "Remove",
        }),
    )
    const attributes: Record<string, string> = {
        [COMPOSER_DOM.atom]: atom.kind,
        [COMPOSER_DOM.entityId]: atom.entityId,
        [COMPOSER_DOM.plain]: chip.plainText,
        contenteditable: "false",
        role: "group",
        "aria-label": chip.ariaLabel,
        title: chip.tooltip,
        class: `composer-chip composer-chip--${chip.tone}`,
    }
    if (chip.busy) attributes["aria-busy"] = "true"
    if (atom.kind === "resource") attributes["data-status"] = atom.status
    const node = element("span", attributes, ...parts)
    chipCache.set(atom, node)
    return node
}

function textPiece(text: string, start: number, className?: string): HTMLSpanElement {
    const attributes: Record<string, string> = { [COMPOSER_DOM.text]: "", [COMPOSER_DOM.start]: String(start) }
    if (className) attributes.class = className
    return element("span", attributes, document.createTextNode(text))
}

function anchor(start: number): HTMLSpanElement {
    return element(
        "span",
        { [COMPOSER_DOM.anchor]: "", [COMPOSER_DOM.start]: String(start), "aria-hidden": "true" },
        document.createTextNode(ZERO_WIDTH_SPACE),
    )
}

/** Cut one text segment at decoration edges; decorations are sorted and do not overlap. */
function decoratedPieces(text: string, start: number, decorations: readonly ComposerDecoration[]): HTMLSpanElement[] {
    const end = start + text.length
    const pieces: HTMLSpanElement[] = []
    let cursor = start
    for (const { range, className } of decorations) {
        if (range.end <= cursor || range.start >= end) continue
        const from = Math.max(cursor, range.start)
        const to = Math.min(end, range.end)
        if (from > cursor) pieces.push(textPiece(text.slice(cursor - start, from - start), cursor))
        pieces.push(textPiece(text.slice(from - start, to - start), from, className))
        cursor = to
    }
    if (cursor < end) pieces.push(textPiece(text.slice(cursor - start), cursor))
    return pieces
}

/** Rebuild the editor content from the model. */
export function renderComposerDom(
    root: HTMLElement,
    segments: readonly ComposerSegment[],
    options: ComposerRenderOptions = {},
): void {
    const decorations = [...(options.decorations ?? [])].sort((left, right) => left.range.start - right.range.start)
    const children: Node[] = []
    let offset = 0
    if (segments[0]?.kind === "atom") children.push(anchor(0))
    segments.forEach((segment, index) => {
        if (segment.kind === "text") {
            children.push(...decoratedPieces(segment.text, offset, decorations))
        } else {
            const chip = chipElement(segment.atom)
            chip.setAttribute(COMPOSER_DOM.start, String(offset))
            chip.classList.toggle("composer-chip--selected", options.selectedAtomIds?.has(segment.atom.entityId) ?? false)
            children.push(chip)
            if (segments[index + 1]?.kind !== "text") children.push(anchor(offset + 1))
        }
        offset += segmentLength(segment)
    })
    if (segments.length === 0 || flatTextOf(segments).endsWith("\n")) {
        children.push(element("br", { [COMPOSER_DOM.filler]: "", [COMPOSER_DOM.start]: String(offset) }))
    }
    root.replaceChildren(...children)
}

/** The child of `root` that contains `node`, or undefined when `node` is outside the editor. */
function childOf(root: HTMLElement, node: Node): ChildNode | undefined {
    let current: Node | null = node
    while (current && current.parentNode !== root) current = current.parentNode
    return current ? (current as ChildNode) : undefined
}

function startOf(node: ChildNode): number {
    return node instanceof HTMLElement ? Number(node.getAttribute(COMPOSER_DOM.start) ?? 0) : 0
}

function isText(node: ChildNode): boolean {
    return node instanceof HTMLElement && node.hasAttribute(COMPOSER_DOM.text)
}

function isAtom(node: ChildNode): boolean {
    return node instanceof HTMLElement && node.hasAttribute(COMPOSER_DOM.atom)
}

function endOf(node: ChildNode): number {
    if (isText(node)) return startOf(node) + (node.textContent?.length ?? 0)
    if (isAtom(node)) return startOf(node) + 1
    return startOf(node)
}

/** The flat offset of a DOM point inside the editor, or undefined when it lies outside. */
export function modelOffsetAt(root: HTMLElement, node: Node, nodeOffset: number): number | undefined {
    if (node === root) {
        const child = root.childNodes[nodeOffset]
        if (child) return startOf(child)
        const last = root.lastChild
        return last ? endOf(last) : 0
    }
    const child = childOf(root, node)
    if (!child) return undefined
    const start = startOf(child)
    if (isText(child)) {
        const length = child.textContent?.length ?? 0
        if (node.nodeType === Node.TEXT_NODE) return start + Math.max(0, Math.min(length, nodeOffset))
        return nodeOffset === 0 ? start : start + length
    }
    if (isAtom(child)) return node === child && nodeOffset === 0 ? start : start + 1
    return start
}

/** The DOM point a flat offset is drawn at; text positions are preferred so the caret is always visible. */
export function domPointAt(root: HTMLElement, offset: number): { readonly node: Node; readonly offset: number } {
    const children = Array.from(root.childNodes)
    for (const [index, child] of children.entries()) {
        const start = startOf(child)
        if (isText(child)) {
            const textNode = child.firstChild
            const end = start + (textNode?.textContent?.length ?? 0)
            if (textNode && offset >= start && offset <= end) return { node: textNode, offset: offset - start }
            continue
        }
        if (child instanceof HTMLElement && child.hasAttribute(COMPOSER_DOM.anchor) && start === offset && child.firstChild) {
            return { node: child.firstChild, offset: 1 }
        }
        if (isAtom(child) && start === offset) return { node: root, offset: index }
    }
    const filler = children.findIndex((child) => child instanceof HTMLElement && child.hasAttribute(COMPOSER_DOM.filler))
    return { node: root, offset: filler === -1 ? children.length : filler }
}

/** The editor's current DOM selection as a model selection, or undefined when it lies outside. */
export function readModelSelection(root: HTMLElement): ComposerSelection | undefined {
    const selection = root.ownerDocument.getSelection()
    if (!selection || !selection.anchorNode || !selection.focusNode) return undefined
    const anchorOffset = modelOffsetAt(root, selection.anchorNode, selection.anchorOffset)
    const focusOffset = modelOffsetAt(root, selection.focusNode, selection.focusOffset)
    if (anchorOffset === undefined || focusOffset === undefined) return undefined
    return { anchor: anchorOffset, focus: focusOffset }
}

/** Draw a model selection in the DOM. */
export function writeModelSelection(root: HTMLElement, selection: ComposerSelection): void {
    const domSelection = root.ownerDocument.getSelection()
    if (!domSelection) return
    const anchorPoint = domPointAt(root, selection.anchor)
    const focusPoint = domPointAt(root, selection.focus)
    domSelection.setBaseAndExtent(anchorPoint.node, anchorPoint.offset, focusPoint.node, focusPoint.offset)
}

/** The model range a browser-reported target range covers. */
export function modelRangeOf(root: HTMLElement, range: StaticRange | Range): ComposerRange | undefined {
    const start = modelOffsetAt(root, range.startContainer, range.startOffset)
    const end = modelOffsetAt(root, range.endContainer, range.endOffset)
    if (start === undefined || end === undefined) return undefined
    return { start: Math.min(start, end), end: Math.max(start, end) }
}

/** The entity id and requested action of a chip control the user clicked. */
export function chipTargetOf(
    root: HTMLElement,
    target: EventTarget | null,
): { entityId: string; action: ChipAction } | undefined {
    if (!(target instanceof Element)) return undefined
    const chip = target.closest(`[${COMPOSER_DOM.atom}]`)
    if (!chip || !root.contains(chip)) return undefined
    const entityId = chip.getAttribute(COMPOSER_DOM.entityId)
    if (!entityId) return undefined
    const action = target.closest(`[${COMPOSER_DOM.chipAction}]`)?.getAttribute(COMPOSER_DOM.chipAction)
    return { entityId, action: action === "remove" || action === "retry" ? action : "open" }
}

/** The draft as plain text: text pieces as written and each atom as its plain contribution. */
export function plainTextOfComposerDom(root: HTMLElement): string {
    return Array.from(root.querySelectorAll<HTMLElement>(`[${COMPOSER_DOM.text}],[${COMPOSER_DOM.atom}]`))
        .map((node) =>
            node.hasAttribute(COMPOSER_DOM.atom) ? (node.getAttribute(COMPOSER_DOM.plain) ?? "") : (node.textContent ?? ""),
        )
        .join("")
}
