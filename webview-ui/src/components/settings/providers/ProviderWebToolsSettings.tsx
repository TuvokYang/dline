import type { WebToolsMode } from "@shared/proto/dline/provider/common"
import { WebToolsModeControl } from "./WebToolsModeControl"

interface ProviderWebToolsSettingsProps {
    value?: WebToolsMode
    onChange: (value: WebToolsMode) => void
    hostedAvailable: boolean
}

/** Display one provider-owned Web Tools routing control and its current hosted availability. */
export function ProviderWebToolsSettings({ value, onChange, hostedAvailable }: ProviderWebToolsSettingsProps) {
    return (
        <div className="mb-2">
            <WebToolsModeControl onChange={onChange} value={value} />
            <p className="m-0 text-xs text-description">
                {hostedAvailable ? "Hosted Web Tools available" : "Hosted Web Tools unavailable for current model or API Format"}
            </p>
        </div>
    )
}
