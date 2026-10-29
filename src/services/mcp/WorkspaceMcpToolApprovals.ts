import { StateManager } from "@core/storage/StateManager"
import { hashStableJson } from "@/shared/stable-json"

const GRANTS_KEY = "workspaceMcpToolAutoApprove"

/** Identity of the descriptor content a grant was given for. */
export function workspaceDescriptorFingerprint(config: unknown): string {
    return hashStableJson(config)
}

/**
 * The user's own auto-approve grants for workspace MCP server tools.
 *
 * A workspace descriptor comes from the repository, so it never grants approval itself: a tool is
 * auto-approved only after the user turns it on in Dline. Grants live in this workspace's settings
 * document on this machine, never in the repository, and each is bound to the descriptor content
 * the user approved, so an edited descriptor starts unapproved again.
 */
export class WorkspaceMcpToolApprovals {
    constructor(private readonly stateManager: () => StateManager = () => StateManager.get()) {}

    isApproved(serverName: string, fingerprint: string, toolName: string): boolean {
        const grant = this.readGrants()[serverName]
        return grant?.fingerprint === fingerprint && grant.tools.includes(toolName)
    }

    /** Grants or withdraws approval for the given tools; a grant for an earlier descriptor is replaced. */
    async update(serverName: string, fingerprint: string, toolNames: readonly string[], approved: boolean): Promise<void> {
        // Workspace settings are written through the scoped preference API, which owns the
        // workspace settings document and its cross-window consistency.
        await this.stateManager().mutateScopedCapabilityToggles("workspace", GRANTS_KEY, (grants) => {
            const current = grants[serverName]
            const tools = new Set(current?.fingerprint === fingerprint ? current.tools : [])
            for (const toolName of toolNames) {
                if (approved) {
                    tools.add(toolName)
                } else {
                    tools.delete(toolName)
                }
            }
            const { [serverName]: _replaced, ...others } = grants
            return tools.size > 0 ? { ...others, [serverName]: { fingerprint, tools: [...tools].sort() } } : others
        })
    }

    private readGrants() {
        const stateManager = this.stateManager()
        // Without an open workspace there are no workspace servers to approve.
        if (!stateManager.hasWorkspaceScope) return {}
        return stateManager.getScopedCapabilityToggles("workspace", GRANTS_KEY)
    }
}
