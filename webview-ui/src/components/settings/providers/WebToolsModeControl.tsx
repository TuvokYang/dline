import { WebToolsMode } from "@shared/proto/dline/provider/common"
import { useId } from "react"
import { ProfileField } from "../profile-ui"

interface WebToolsModeControlProps {
    value?: WebToolsMode
    onChange: (value: WebToolsMode) => void
}

const WEB_TOOLS_MODE_OPTIONS = [
    { value: WebToolsMode.WEB_TOOLS_MODE_AUTO, label: "Auto" },
    { value: WebToolsMode.WEB_TOOLS_MODE_FORCE_LOCAL, label: "Local only" },
    { value: WebToolsMode.WEB_TOOLS_MODE_FORCE_OFF, label: "Off" },
    { value: WebToolsMode.WEB_TOOLS_MODE_FORCE_REMOTE, label: "Hosted only" },
] as const

/**
 * Per-profile routing policy covering every web tool (Web Search and Web Fetch).
 * Changes are persisted by the profile owner.
 */
export function WebToolsModeControl({ value, onChange }: WebToolsModeControlProps) {
    const selectedValue = value ?? WebToolsMode.WEB_TOOLS_MODE_AUTO
    const inputId = useId()

    return (
        <ProfileField htmlFor={inputId} label="Web Tools">
            <select
                aria-label="Web Tools mode"
                className="min-h-7 w-full rounded-xs border border-input-border bg-input-background px-2 text-sm"
                id={inputId}
                onChange={(event) => onChange(Number(event.target.value) as WebToolsMode)}
                value={selectedValue}>
                {WEB_TOOLS_MODE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                        {option.label}
                    </option>
                ))}
            </select>
        </ProfileField>
    )
}
