import type { CSSProperties } from "react"

/**
 * Theme tokens for native `<select>` controls.
 *
 * The popup list of a native select is rendered by the host (Chromium), so it does not
 * inherit Tailwind classes or CSS applied through class selectors. Without an explicit
 * background/foreground on the element and on every `<option>`, the popup falls back to
 * the browser default light palette, which is unreadable inside a dark VS Code theme.
 * Apply these styles inline to keep native dropdowns aligned with the active theme.
 */
export const nativeSelectStyle: CSSProperties = {
    backgroundColor: "var(--vscode-dropdown-background)",
    borderColor: "var(--vscode-dropdown-border)",
    color: "var(--vscode-dropdown-foreground)",
}

/** Companion style for every `<option>` rendered inside a native select popup. */
export const nativeSelectOptionStyle: CSSProperties = {
    backgroundColor: "var(--vscode-dropdown-background)",
    color: "var(--vscode-dropdown-foreground)",
}
