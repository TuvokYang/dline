import { ApiProfile } from "@shared/proto/dline/profile"
import { renderHook, waitFor } from "@testing-library/react"
import React, { type PropsWithChildren } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ExtensionStateContext, type ExtensionStateContextType } from "../../../context/ExtensionStateContext"

/**
 * P0 regression guards for the bottom-bar Profile selector stuck on "Loading profiles…".
 *
 * The shared Catalog store is module-level, so every consumer (sidebar and each
 * editor panel) observes one `loaded` flag. A failed or never-settled first load
 * must not leave every surface permanently unresolved.
 */

const mocks = vi.hoisted(() => ({
    getApiProfiles: vi.fn(),
    updateApiProfiles: vi.fn(),
}))

vi.mock("../../../services/grpc-client", () => ({
    FileServiceClient: {
        getApiProfiles: mocks.getApiProfiles,
        updateApiProfiles: mocks.updateApiProfiles,
    },
    StateServiceClient: { requestProfileSwitch: vi.fn() },
}))

function createWrapper(profileCatalogRevision: number) {
    return ({ children }: PropsWithChildren) =>
        React.createElement(
            ExtensionStateContext.Provider,
            { value: { profileCatalogRevision } as ExtensionStateContextType },
            children,
        )
}

describe("useApiProfiles Catalog load recovery", () => {
    beforeEach(() => {
        vi.resetModules()
        mocks.getApiProfiles.mockReset()
        mocks.updateApiProfiles.mockReset().mockResolvedValue({})
    })

    it("surfaces a load error instead of staying silently unresolved", async () => {
        mocks.getApiProfiles.mockRejectedValue(new Error("Unary RPC getApiProfiles timed out after 30s"))
        const { useApiProfiles } = await import("./useApiProfiles")

        const { result } = renderHook(() => useApiProfiles(), { wrapper: createWrapper(900) })

        // A failed load must be observable so the UI can render "Profiles unavailable"
        // instead of an indefinite "Loading profiles…" label.
        await waitFor(() => expect(result.current.error).toBeInstanceOf(Error))
        expect(result.current.loaded).toBe(false)
    })

    it("recovers the Catalog on the next revision after a failed load", async () => {
        mocks.getApiProfiles
            .mockRejectedValueOnce(new Error("transient RPC failure"))
            .mockResolvedValue({ profiles: [ApiProfile.create({ id: "recovered", name: "Recovered" })] })
        const { useApiProfiles } = await import("./useApiProfiles")

        let revision = 910
        const { result, rerender } = renderHook(() => useApiProfiles(), {
            wrapper: createWrapper(revision),
        })
        await waitFor(() => expect(result.current.error).toBeInstanceOf(Error))

        revision = 911
        rerender()

        await waitFor(() => expect(result.current.loaded).toBe(true))
        expect(result.current.profiles[0]?.id).toBe("recovered")
        expect(result.current.error).toBeUndefined()
    })

    it("resolves every concurrent consumer from one in-flight Catalog request", async () => {
        let resolveRequest: ((value: unknown) => void) | undefined
        mocks.getApiProfiles.mockImplementation(
            () =>
                new Promise((resolve) => {
                    resolveRequest = resolve
                }),
        )
        const { useApiProfiles } = await import("./useApiProfiles")

        // Several panels mount against the same shared store before the RPC settles.
        const first = renderHook(() => useApiProfiles(), { wrapper: createWrapper(920) })
        const second = renderHook(() => useApiProfiles(), { wrapper: createWrapper(920) })
        const third = renderHook(() => useApiProfiles(), { wrapper: createWrapper(920) })

        expect(first.result.current.loaded).toBe(false)
        resolveRequest?.({ profiles: [ApiProfile.create({ id: "shared", name: "Shared" })] })

        await waitFor(() => expect(first.result.current.loaded).toBe(true))
        await waitFor(() => expect(second.result.current.loaded).toBe(true))
        await waitFor(() => expect(third.result.current.loaded).toBe(true))
        // One shared request must serve every consumer.
        expect(mocks.getApiProfiles).toHaveBeenCalledTimes(1)
    })
})
