import { McpDisplayMode } from "@shared/McpDisplayMode"
import React from "react"
import { nativeSelectOptionStyle, nativeSelectStyle } from "@/components/ui/native-select-theme"

interface McpDisplayModeDropdownProps {
    value: McpDisplayMode
    onChange: (mode: McpDisplayMode) => void
    id?: string
    className?: string
    style?: React.CSSProperties
    onClick?: (e: React.MouseEvent) => void
}

const DISPLAY_MODES: ReadonlyArray<{ readonly value: McpDisplayMode; readonly label: string }> = [
    { value: "plain", label: "Plain Text" },
    { value: "rich", label: "Rich Display" },
    { value: "markdown", label: "Markdown" },
]

/**
 * A native select painted from the live `--vscode-dropdown-*` variables.
 *
 * The toolkit dropdown it replaces painted from design tokens the toolkit
 * resolved once, so a light theme could still show its dark palette.
 */
const McpDisplayModeDropdown: React.FC<McpDisplayModeDropdownProps> = ({ value, onChange, id, className, style, onClick }) => (
    <select
        aria-label="Response display mode"
        className={["min-h-6 rounded-xs border px-1.5 text-xs", className].filter(Boolean).join(" ")}
        id={id}
        onChange={(event) => onChange(event.target.value as McpDisplayMode)}
        onClick={onClick}
        style={{ ...nativeSelectStyle, ...style }}
        value={value}>
        {DISPLAY_MODES.map((mode) => (
            <option key={mode.value} style={nativeSelectOptionStyle} value={mode.value}>
                {mode.label}
            </option>
        ))}
    </select>
)

export default McpDisplayModeDropdown
