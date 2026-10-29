// Mode import removed — no longer needed in profile-driven architecture
import { ApiKeyField } from "../common/ApiKeyField"
import { DebouncedTextField } from "../common/DebouncedTextField"
import type { ApiProfile } from "./ProviderProfile"

interface DifyProviderProps {
    showModelOptions: boolean
    isPopup?: boolean
    profile: ApiProfile
    onUpdate: (updates: Partial<ApiProfile>) => void
}

/** Dify provider �?all data from ApiProfile. baseUrl used for Dify instance URL. */
export const DifyProvider = ({
    showModelOptions: _showModelOptions,
    isPopup: _isPopup,
    profile,
    onUpdate,
}: DifyProviderProps) => {
    return (
        <div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <DebouncedTextField
                    initialValue={profile.baseUrl || ""}
                    onChange={(value) => onUpdate({ baseUrl: value })}
                    placeholder="Enter base URL..."
                    style={{ width: "100%", marginBottom: 10 }}
                    type="text">
                    <span style={{ fontWeight: 500 }}>Base URL</span>
                </DebouncedTextField>
                <ApiKeyField
                    initialValue={profile.apiKey}
                    onChange={(value) => onUpdate({ apiKey: value })}
                    providerName="Dify"
                />
                <div style={{ fontSize: "12px", color: "var(--vscode-descriptionForeground)", marginTop: "5px" }}>
                    <p>Dify is a platform that provides access to various AI models through a unified API.</p>
                    <p style={{ marginTop: "8px" }}>
                        <strong>Note:</strong> The model selection is handled within your Dify application configuration.
                    </p>
                </div>
            </div>
        </div>
    )
}
