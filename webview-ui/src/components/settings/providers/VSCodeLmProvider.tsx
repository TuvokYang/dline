// Mode import removed — no longer needed in profile-driven architecture
import type { ApiProfile } from "./ProviderProfile"

interface VSCodeLmProviderProps {
    showModelOptions?: boolean
    profile?: ApiProfile
    onUpdate?: (updates: Partial<ApiProfile>) => void
}

/** VS Code LM provider �?uses built-in VS Code language models. No API configuration needed. */
export const VSCodeLmProvider = ({}: VSCodeLmProviderProps) => {
    return (
        <div>
            <p style={{ fontSize: "12px", color: "var(--vscode-descriptionForeground)" }}>
                VS Code LM uses the built-in language models available in your VS Code installation. No API key or configuration
                is needed.
            </p>
        </div>
    )
}
