import type { ClaudeCodeIdentityConfig } from "@shared/proto/dline/provider/common"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import styled from "styled-components"

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
				Send Claude Code billing header
			</StyledCheckbox>
			<Description>
				Adds the Claude Code billing attribution block to each request. Anthropic uses several signals to attribute a
				request, so this alone does not guarantee your subscription quota applies. Leave it off unless you know you need
				it.
			</Description>
		</div>
	)
}
