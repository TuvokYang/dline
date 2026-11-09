import type { ClaudeCodeIdentityConfig } from "@shared/proto/dline/provider/common"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import styled from "styled-components"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"

const StyledCheckbox = styled(VSCodeCheckbox)`
	margin-bottom: 4px;
`

const Description = styled.p`
	font-size: 12px;
	margin: -2px 0 6px 0;
	color: var(--vscode-descriptionForeground);
`

export interface ClaudeCodeIdentitySectionProps {
    config: ClaudeCodeIdentityConfig | undefined
    onChange: (config: ClaudeCodeIdentityConfig) => void
}

/**
 * Opt-in toggle for the Claude Code billing attribution block.
 *
 * Shared by the anthropic and claude-code provider pages so both read one
 * configuration message instead of maintaining parallel toggles. Only the
 * attribution block is controlled here; beta values and fingerprint headers
 * belong to whichever provider declares a full client identity.
 */
export const ClaudeCodeIdentitySection = ({ config, onChange }: ClaudeCodeIdentitySectionProps) => {
    const { t } = useUiTranslation()
    const enabled = config?.enabled === true

    return (
        <div>
            <StyledCheckbox
                checked={enabled}
                onChange={(event: Event | React.FormEvent<HTMLElement>) =>
                    onChange({
                        ...(config ?? { enabled: false, clientVersionOverride: undefined, entrypointOverride: undefined }),
                        enabled: (event.target as HTMLInputElement | null)?.checked === true,
                    })
                }>
                {t("settings.ui.claudeIdentity.enable")}
            </StyledCheckbox>
            <Description>{t("settings.ui.claudeIdentity.help")}</Description>
        </div>
    )
}
