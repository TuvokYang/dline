import type { ClineFeatureSetting } from "@shared/ClineFeatureSetting"
import { render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { Navbar } from "./Navbar"

const extensionState = vi.hoisted(() => ({
    current: {} as { accountEnabled?: ClineFeatureSetting },
}))

vi.mock("../../context/ExtensionStateContext", () => ({
    useExtensionState: () => ({
        navigateToHistory: vi.fn(),
        navigateToSettings: vi.fn(),
        navigateToAccount: vi.fn(),
        navigateToMcp: vi.fn(),
        navigateToChat: vi.fn(),
        ...extensionState.current,
    }),
}))

vi.mock("@/services/grpc-client", () => ({
    TaskServiceClient: { clearTask: vi.fn().mockResolvedValue({}) },
}))

describe("Navbar account entry", () => {
    beforeEach(() => {
        extensionState.current = {}
    })

    it("is absent when the extension has not reported the feature", () => {
        render(<Navbar />)

        expect(screen.queryByTestId("tab-account")).toBeNull()
        expect(screen.getByTestId("tab-settings")).toBeTruthy()
    })

    it("is absent while the rollout offers the feature but the user has not opted in", () => {
        extensionState.current = { accountEnabled: { featureFlag: true, user: false } }
        render(<Navbar />)

        expect(screen.queryByTestId("tab-account")).toBeNull()
    })

    it("is absent when the user opted in but the rollout withdrew the feature", () => {
        extensionState.current = { accountEnabled: { featureFlag: false, user: true } }
        render(<Navbar />)

        expect(screen.queryByTestId("tab-account")).toBeNull()
    })

    it("appears once both the rollout and the user turn it on", () => {
        extensionState.current = { accountEnabled: { featureFlag: true, user: true } }
        render(<Navbar />)

        expect(screen.getByTestId("tab-account")).toBeTruthy()
    })
})
