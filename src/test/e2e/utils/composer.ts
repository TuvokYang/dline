import { expect, type Frame, type Locator } from "@playwright/test"

/**
 * Black-box access to the semantic chat composer.
 *
 * The composer is a contenteditable textbox, not a textarea: it has no `value`,
 * `placeholder` or `selectionStart`. These helpers read and drive it through the
 * DOM contract the Webview renders, so a test asserts what the user sees and
 * would send:
 *
 * - every run of text is an element marked `data-composer-text` with its flat
 *   start offset in `data-start`;
 * - every atom (command, mention, resource) is a chip marked
 *   `data-composer-atom` that contributes its `data-plain` text, empty for a
 *   resource, and occupies one flat offset;
 * - the placeholder is announced through `aria-placeholder`.
 *
 * Typing still goes through Playwright's keyboard and `fill`, which reach the
 * editor as `beforeinput` events exactly as a user's input does.
 *
 * Page-side code that runs between Playwright calls, such as a MutationObserver
 * callback, reads the draft through `installComposerTextReader` instead of
 * re-implementing this projection.
 */

const COMPOSER_TEXT_ATTRIBUTE = "data-composer-text"
const COMPOSER_ATOM_ATTRIBUTE = "data-composer-atom"
const COMPOSER_PLAIN_ATTRIBUTE = "data-plain"
const COMPOSER_START_ATTRIBUTE = "data-start"
const COMPOSER_ANCHOR_ATTRIBUTE = "data-composer-anchor"

interface ComposerTextExpectation {
    readonly timeout?: number
    readonly message?: string
}

/** The window of a Webview frame after `installComposerTextReader`. */
export interface ComposerTextReaderWindow {
    __dlineE2EComposerText?: (root: Element) => string
}

/**
 * The draft of a composer root as plain text: text runs as written and each
 * atom as its written form.
 *
 * Playwright ships this function's source into the Webview, so it must stay
 * self-contained: no closure over module constants, hence the literal selectors.
 */
function readComposerDraft(root: Element): string {
    return Array.from(root.querySelectorAll<HTMLElement>("[data-composer-text],[data-composer-atom]"))
        .map((node) =>
            node.hasAttribute("data-composer-atom") ? (node.getAttribute("data-plain") ?? "") : (node.textContent ?? ""),
        )
        .join("")
}

/** The draft as plain text: text runs as written and each atom as its written form. */
export function composerText(input: Locator): Promise<string> {
    return input.evaluate(readComposerDraft)
}

/**
 * Expose the draft reader to page-side code in `frame` as
 * `window.__dlineE2EComposerText`; see `ComposerTextReaderWindow`.
 *
 * A Webview reload drops it, as it drops any observer that would use it.
 */
export async function installComposerTextReader(frame: Frame): Promise<void> {
    await frame.evaluate(`window.__dlineE2EComposerText = ${readComposerDraft.toString()}`)
}

/** Wait until the draft reads as `expected`; the composer counterpart of `toHaveValue`. */
export async function expectComposerText(
    input: Locator,
    expected: string | RegExp,
    options: ComposerTextExpectation = {},
): Promise<void> {
    const poll = expect.poll(() => composerText(input), { timeout: options.timeout, message: options.message })
    if (typeof expected === "string") await poll.toBe(expected)
    else await poll.toMatch(expected)
}

/** Wait until the draft no longer reads as `unexpected`. */
export async function expectComposerTextNot(
    input: Locator,
    unexpected: string,
    options: ComposerTextExpectation = {},
): Promise<void> {
    await expect.poll(() => composerText(input), { timeout: options.timeout, message: options.message }).not.toBe(unexpected)
}

/** Wait until the composer announces `expected` as its placeholder. */
export async function expectComposerPlaceholder(
    input: Locator,
    expected: string | RegExp,
    options: { readonly timeout?: number } = {},
): Promise<void> {
    await expect(input).toHaveAttribute("aria-placeholder", expected, options)
}

/** The placeholder the composer currently announces. */
export function composerPlaceholder(input: Locator): Promise<string | null> {
    return input.getAttribute("aria-placeholder")
}

/**
 * Put a collapsed caret at a flat draft offset, where an atom counts as one.
 *
 * The editor follows the document selection, so a caret placed here is where
 * the next key or paste lands, as if the user had clicked there.
 */
export async function placeComposerCaret(input: Locator, offset: number): Promise<void> {
    await input.focus()
    await input.evaluate(
        (root, { offset: target, attributes }) => {
            const selection = root.ownerDocument.getSelection()
            if (!selection) throw new Error("the composer document has no selection")
            for (const piece of Array.from(root.querySelectorAll<HTMLElement>(`[${attributes.text}]`))) {
                const start = Number(piece.getAttribute(attributes.start))
                const text = piece.firstChild
                const length = text?.textContent?.length ?? 0
                if (text && target >= start && target <= start + length) {
                    selection.setBaseAndExtent(text, target - start, text, target - start)
                    return
                }
            }
            const anchor = root.querySelector<HTMLElement>(`[${attributes.anchor}][${attributes.start}="${target}"]`)
            if (!anchor) throw new Error(`no caret position at composer offset ${target}`)
            const point = anchor.firstChild ?? anchor
            selection.setBaseAndExtent(point, 0, point, 0)
        },
        {
            offset,
            attributes: { text: COMPOSER_TEXT_ATTRIBUTE, start: COMPOSER_START_ATTRIBUTE, anchor: COMPOSER_ANCHOR_ATTRIBUTE },
        },
    )
}

/** Chips in the draft, in order, with the plain text each contributes. */
export function composerAtoms(input: Locator): Promise<{ kind: string; plainText: string; label: string }[]> {
    return input.evaluate(
        (root, attributes) =>
            Array.from(root.querySelectorAll<HTMLElement>(`[${attributes.atom}]`)).map((chip) => ({
                kind: chip.getAttribute(attributes.atom) ?? "",
                plainText: chip.getAttribute(attributes.plain) ?? "",
                label: chip.getAttribute("aria-label") ?? "",
            })),
        { atom: COMPOSER_ATOM_ATTRIBUTE, plain: COMPOSER_PLAIN_ATTRIBUTE },
    )
}
