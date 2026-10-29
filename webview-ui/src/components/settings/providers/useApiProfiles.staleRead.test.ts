import { ApiProfile } from "@shared/proto/dline/profile"
import { act, renderHook, waitFor } from "@testing-library/react"
import React, { type PropsWithChildren } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ExtensionStateContext, type ExtensionStateContextType } from "../../../context/ExtensionStateContext"

/**
 * Regression guard for edits reverting to their previously stored value.
 *
 * Committing a Catalog write advances the backend revision, which asks this
 * Webview to read the Catalog again. That read answers with the backend state
 * as of the moment it ran, so an edit committed while the read is in flight is
 * absent from its response. Adopting such a response silently reverts the edit,
 * which surfaces as a settings field snapping back to its old value.
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

/** The value already stored in the Catalog before the user edits it. */
function storedProfile(): ApiProfile {
    return ApiProfile.create({ id: "profile-1", name: "Stored", modelId: "stored-model" })
}

describe("useApiProfiles stale Catalog reads", () => {
    beforeEach(() => {
        vi.resetModules()
        mocks.getApiProfiles.mockReset()
        mocks.updateApiProfiles.mockReset().mockResolvedValue({})
    })

    it("keeps a local edit when an in-flight Catalog read answers with the pre-edit state", async () => {
        let resolveReload: ((response: { profiles: ApiProfile[] }) => void) | undefined
        mocks.getApiProfiles.mockResolvedValueOnce({ profiles: [storedProfile()] }).mockImplementationOnce(
            () =>
                new Promise<{ profiles: ApiProfile[] }>((resolve) => {
                    resolveReload = resolve
                }),
        )

        const { useApiProfiles } = await import("./useApiProfiles")
        const { result } = renderHook(() => useApiProfiles(), { wrapper: createWrapper(930) })
        await waitFor(() => expect(result.current.loaded).toBe(true))

        // A committed write advanced the backend revision, so a Catalog read starts.
        let reload: Promise<unknown> | undefined
        act(() => {
            reload = result.current.reloadProfiles()
        })
        await waitFor(() => expect(mocks.getApiProfiles).toHaveBeenCalledTimes(2))

        // The user edits while that read is still in flight.
        act(() => {
            result.current.updateProfile("profile-1", { modelId: "edited-model" })
        })
        expect(result.current.profiles[0].modelId).toBe("edited-model")

        // The read now answers, carrying the state from before the edit.
        await act(async () => {
            resolveReload?.({ profiles: [storedProfile()] })
            await reload
        })

        // The edit is already queued for the backend, so it must survive.
        expect(result.current.profiles[0].modelId).toBe("edited-model")
    })

    it("adopts a Catalog read issued after the local edit", async () => {
        mocks.getApiProfiles
            .mockResolvedValueOnce({ profiles: [storedProfile()] })
            .mockResolvedValue({ profiles: [ApiProfile.create({ id: "profile-1", name: "Stored", modelId: "backend-model" })] })

        const { useApiProfiles } = await import("./useApiProfiles")
        const { result } = renderHook(() => useApiProfiles(), { wrapper: createWrapper(940) })
        await waitFor(() => expect(result.current.loaded).toBe(true))

        act(() => {
            result.current.updateProfile("profile-1", { modelId: "edited-model" })
        })

        // A read that starts after the edit reflects it, so the backend stays
        // authoritative and external changes still reach the editor.
        await act(async () => {
            await result.current.reloadProfiles()
        })
        expect(result.current.profiles[0].modelId).toBe("backend-model")
    })
})
