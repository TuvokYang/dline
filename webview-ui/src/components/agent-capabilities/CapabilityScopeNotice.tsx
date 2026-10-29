/**
 * The storage layer a capability toggle is written to.
 *
 * This is not the same as where a resource comes from. A rule discovered in the
 * global directory can still be turned off for one task only; the section
 * heading names the origin, while this notice names the layer the change lands in.
 */
export type CapabilityStorageScope = "global" | "workspace" | "task"

interface CapabilityScopeNoticeProps {
    scope: CapabilityStorageScope
}

const SCOPE_TEXT: Readonly<Record<CapabilityStorageScope, string>> = {
    global: "Toggles saved globally",
    workspace: "Toggles saved for this workspace",
    task: "Toggles saved for this task only",
}

/**
 * Tell the user which layer a toggle in this panel is stored in.
 *
 * The panel is a dense list, so this stays one muted italic line with no icon:
 * it answers a question the user only asks once, and must not compete with the
 * toggles themselves.
 */
export const CapabilityScopeNotice = ({ scope }: CapabilityScopeNoticeProps) => (
    <div
        className="-mt-0.5 mb-3 text-[11px] italic text-vscode-descriptionForeground"
        data-scope={scope}
        data-testid="capability-scope-notice">
        {SCOPE_TEXT[scope]}
    </div>
)
