import { VSCodeDropdown, VSCodeOption } from "@vscode/webview-ui-toolkit/react"
import type { ComponentProps } from "react"

type LocalizedDropdownProps = ComponentProps<typeof VSCodeDropdown> & {
    selectedLabel?: string
}

/** FAST's fallback display does not observe React text-node updates. Keep the label explicit and presentation-only. */
export function LocalizedDropdown({ selectedLabel, children, ...props }: LocalizedDropdownProps) {
    return (
        <VSCodeDropdown {...props}>
            {selectedLabel !== undefined && <span slot="selected-value">{selectedLabel}</span>}
            {children}
        </VSCodeDropdown>
    )
}

type LocalizedOptionProps = Omit<ComponentProps<typeof VSCodeOption>, "children" | "ref"> & {
    label: string
}

/** The toolkit initializes aria-label only on connection; an explicit prop also follows later label changes. */
export function LocalizedOption({ label, "aria-label": ariaLabel, ...props }: LocalizedOptionProps) {
    const accessibleLabel = ariaLabel ?? props.ariaLabel ?? label
    // The public property is applied after connection, which otherwise overwrites explicit ARIA on first mount.
    return (
        <VSCodeOption {...props} aria-label={accessibleLabel} ariaLabel={accessibleLabel}>
            {label}
        </VSCodeOption>
    )
}
