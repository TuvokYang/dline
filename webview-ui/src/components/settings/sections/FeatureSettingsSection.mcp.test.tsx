// @vitest-environment jsdom

import { fireEvent, render } from "@testing-library/react"
import type { ButtonHTMLAttributes, ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import FeatureSettingsSection from "./FeatureSettingsSection"

const mocks = vi.hoisted(() => ({
    extensionState: {
        clineWebToolsEnabled: true,
        focusChainSettings: { enabled: false, remindClineInterval: 6 },
        mcpDisplayMode: "plain",
        mcpEnabled: true,
        remoteConfigSettings: {},
        worktreesEnabled: { featureFlag: true, user: true },
        externalFileCheckpoints: { featureFlag: false, user: false },
    },
    updateSetting: vi.fn(),
}))

vi.mock("@/context/ExtensionStateContext", () => ({
    useExtensionState: () => mocks.extensionState,
}))

vi.mock("../utils/settingsHandlers", () => ({
    updateSetting: (...args: unknown[]) => mocks.updateSetting(...args),
}))

vi.mock("@/components/ui/switch", () => ({
    Switch: ({
        checked,
        onCheckedChange,
        ...props
    }: ButtonHTMLAttributes<HTMLButtonElement> & { checked?: boolean; onCheckedChange?: (checked: boolean) => void }) => (
        <button aria-checked={checked} onClick={() => onCheckedChange?.(!checked)} role="switch" type="button" {...props} />
    ),
}))

vi.mock("@/components/ui/tooltip", () => ({
    Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
    TooltipContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

vi.mock("@/components/ui/label", () => ({ Label: ({ children }: { children: ReactNode }) => <div>{children}</div> }))
vi.mock("@/components/ui/select", () => ({
    Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    SelectItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    SelectTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    SelectValue: () => null,
}))
vi.mock("../AutoCondenseSettings", () => ({ default: () => null }))
vi.mock("../Section", () => ({ default: ({ children }: { children: ReactNode }) => <div>{children}</div> }))
vi.mock("../SettingsSlider", () => ({ default: () => null }))
vi.mock("./WebToolsSettings", () => ({ default: () => null }))

describe("FeatureSettingsSection feature gates", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.extensionState.mcpEnabled = true
        mocks.extensionState.externalFileCheckpoints = { featureFlag: false, user: false }
    })

    it("shows MCP as enabled by default and persists disabling it", () => {
        const { container } = render(<FeatureSettingsSection renderSectionHeader={() => null} />)
        const toggle = container.querySelector<HTMLButtonElement>('[id="Enable MCP"]')

        expect(toggle).toHaveAttribute("aria-checked", "true")
        fireEvent.click(toggle as HTMLButtonElement)
        expect(mocks.updateSetting).toHaveBeenCalledWith("mcpEnabled", false)
    })

    it("hides external file checkpoints until the rollout flag offers it", () => {
        const { container } = render(<FeatureSettingsSection renderSectionHeader={() => null} />)

        expect(container.querySelector('[id="External File Checkpoints"]')).toBeNull()
    })

    it("shows the rollout setting and persists the user opt-in separately", () => {
        mocks.extensionState.externalFileCheckpoints = { featureFlag: true, user: false }
        const { container } = render(<FeatureSettingsSection renderSectionHeader={() => null} />)
        const toggle = container.querySelector<HTMLButtonElement>('[id="External File Checkpoints"]')

        expect(toggle).toHaveAttribute("aria-checked", "false")
        fireEvent.click(toggle as HTMLButtonElement)
        expect(mocks.updateSetting).toHaveBeenCalledWith("externalFileCheckpointsEnabled", true)
    })
})
