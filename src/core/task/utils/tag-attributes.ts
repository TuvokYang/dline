/**
 * Attributes of a tag the model reads, such as `<image name="…" path="…">`.
 *
 * Values are user- or file-controlled, so each is escaped for a double-quoted
 * attribute: a name cannot close the tag or forge a second attribute. Entries
 * render in insertion order, so a caller that spreads its identity last keeps
 * any earlier attribute from renaming it.
 */
export function tagAttributes(attributes: Readonly<Record<string, string>>): string {
    return Object.entries(attributes)
        .map(([key, value]) => `${key}="${escapeTagAttribute(value)}"`)
        .join(" ")
}

function escapeTagAttribute(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}
