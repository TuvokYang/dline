import type { ProfileSwitchSnapshot } from "@shared/profile-switch"
import { PlanActMode, ProfileSwitchResponse, ProfileSwitchStatus } from "@shared/proto/dline/state"
import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { StateServiceClient } from "../../../services/grpc-client"
import { useProfileSwitch } from "./useProfileSwitch"

vi.mock("../../../services/grpc-client", () => ({
    StateServiceClient: {
        requestProfileSwitch: vi.fn(),
        confirmProfileSwitch: vi.fn(),
        cancelProfileSwitch: vi.fn(),
    },
}))

/**
 * Build a Profile switch RPC response.
 *
 * @param status The reported switch status.
 * @param operationId The operation identity carried by the response.
 * @param error An optional failure reason.
 * @returns The protobuf response object.
 */
function response(status: ProfileSwitchStatus, operationId = "profile-operation-1", error?: string): ProfileSwitchResponse {
    return ProfileSwitchResponse.create({ status, operationId, error })
}

/**
 * Build a published Profile switch snapshot.
 *
 * @param phase The transition phase carried by the snapshot.
 * @returns The snapshot published to the webview.
 */
function snapshot(phase: ProfileSwitchSnapshot["phase"]): ProfileSwitchSnapshot {
    return {
        phase,
        operationId: "profile-operation-1",
        taskId: "task-1",
        activeMode: "act",
        targetModes: ["act"],
        sourceProfile: "large-profile",
        targetProfile: "small-profile",
        currentTokens: 92_000,
        targetContextWindow: 100_000,
        fittingExitTarget: 80_000,
    }
}

describe("useProfileSwitch", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.mocked(StateServiceClient.requestProfileSwitch).mockResolvedValue(
            response(ProfileSwitchStatus.PROFILE_SWITCH_STATUS_CONFIRMATION_REQUIRED),
        )
        vi.mocked(StateServiceClient.confirmProfileSwitch).mockResolvedValue(
            response(ProfileSwitchStatus.PROFILE_SWITCH_STATUS_SWITCHED),
        )
        vi.mocked(StateServiceClient.cancelProfileSwitch).mockResolvedValue(
            response(ProfileSwitchStatus.PROFILE_SWITCH_STATUS_REJECTED),
        )
    })

    it("requests an active-task Profile transition without optimistically adopting the target", async () => {
        const { result } = renderHook(() => useProfileSwitch({ profileSwitch: { phase: "idle" } }))

        await act(async () => result.current.requestSwitch("small-profile", ["act"]))

        expect(StateServiceClient.requestProfileSwitch).toHaveBeenCalledWith(
            expect.objectContaining({
                targetProfile: "small-profile",
                targetModes: [PlanActMode.ACT],
            }),
        )
    })

    it("describes the advisory window check through the published status text", () => {
        const { result } = renderHook(() => useProfileSwitch({ profileSwitch: snapshot("preflighting") }))

        expect(result.current.statusText).toBe("Checking target context window...")
    })

    it("keeps a terminal failure out of the persistent Profile selector status", () => {
        const { result } = renderHook(() =>
            useProfileSwitch({ profileSwitch: { ...snapshot("failed"), error: "Profile switch state changed before commit." } }),
        )

        expect(result.current.statusText).toBeUndefined()
        expect(result.current.error).toBe("Profile switch state changed before commit.")
    })

    it("publishes no status text once the backend returns to idle", () => {
        const { result } = renderHook(() => useProfileSwitch({ profileSwitch: snapshot("idle") }))

        expect(result.current.statusText).toBeUndefined()
        expect(result.current.error).toBeUndefined()
    })

    it("accepts consecutive switches without any client-side latch", async () => {
        // Selecting a Profile only rebinds the handler, so the selector must never refuse a
        // later request. A previous client-side pending latch could strand itself and made
        // the second selection silently disappear before reaching the backend.
        const { result } = renderHook(() => useProfileSwitch({ profileSwitch: { phase: "idle" } }))

        await act(async () => result.current.requestSwitch("small-profile", ["act"]))
        await act(async () => result.current.requestSwitch("other-profile", ["act"]))

        expect(StateServiceClient.requestProfileSwitch).toHaveBeenCalledTimes(2)
        expect(StateServiceClient.requestProfileSwitch).toHaveBeenLastCalledWith(
            expect.objectContaining({ targetProfile: "other-profile" }),
        )
    })

    it("still issues a request while an earlier operation is awaiting confirmation", async () => {
        const { result } = renderHook(() => useProfileSwitch({ profileSwitch: snapshot("awaiting_confirmation") }))

        await act(async () => result.current.requestSwitch("other-profile", ["act"]))

        expect(StateServiceClient.requestProfileSwitch).toHaveBeenCalledTimes(1)
    })

    it("ignores a request without any target mode", async () => {
        const { result } = renderHook(() => useProfileSwitch({ profileSwitch: { phase: "idle" } }))

        await act(async () => result.current.requestSwitch("small-profile", []))

        expect(StateServiceClient.requestProfileSwitch).not.toHaveBeenCalled()
    })

    it("survives a rejected request RPC without throwing", async () => {
        vi.mocked(StateServiceClient.requestProfileSwitch).mockRejectedValue(new Error("transport failed"))
        const { result } = renderHook(() => useProfileSwitch({ profileSwitch: { phase: "idle" } }))

        await act(async () => result.current.requestSwitch("small-profile", ["act"]))

        expect(StateServiceClient.requestProfileSwitch).toHaveBeenCalledTimes(1)
    })

    it("carries the composer draft read at request time", async () => {
        const { result, rerender } = renderHook(
            (props: { text: string }) =>
                useProfileSwitch({ profileSwitch: { phase: "idle" }, draft: { text: props.text, images: [], files: [] } }),
            { initialProps: { text: "first" } },
        )
        rerender({ text: "answer under the new Profile" })

        await act(async () => result.current.requestSwitch("small-profile", ["act"]))

        expect(StateServiceClient.requestProfileSwitch).toHaveBeenCalledWith(
            expect.objectContaining({
                chatContent: expect.objectContaining({ message: "answer under the new Profile" }),
            }),
        )
    })

    it("sends no draft content for an empty composer", async () => {
        const { result } = renderHook(() =>
            useProfileSwitch({ profileSwitch: { phase: "idle" }, draft: { text: "  ", images: [], files: [] } }),
        )

        await act(async () => result.current.requestSwitch("small-profile", ["act"]))

        expect(vi.mocked(StateServiceClient.requestProfileSwitch).mock.calls[0]?.[0].chatContent).toBeUndefined()
    })

    function composerHolding(holds = true) {
        return { holds: vi.fn(() => holds), retire: vi.fn() }
    }

    function response(status: ProfileSwitchStatus, draftDelivered?: boolean): ProfileSwitchResponse {
        return ProfileSwitchResponse.create({ status, operationId: "profile-operation-1", draftDelivered })
    }

    it("lets the composer go only when a switch reports its draft delivered", async () => {
        const composer = composerHolding()
        const draft = { text: "reply", images: [], files: [] }
        vi.mocked(StateServiceClient.requestProfileSwitch).mockResolvedValueOnce(
            response(ProfileSwitchStatus.PROFILE_SWITCH_STATUS_SWITCHED, false),
        )
        const { result } = renderHook(() => useProfileSwitch({ profileSwitch: { phase: "idle" }, draft, composer }))

        await act(async () => result.current.requestSwitch("small-profile", ["act"]))
        expect(composer.retire).not.toHaveBeenCalled()

        vi.mocked(StateServiceClient.requestProfileSwitch).mockResolvedValueOnce(
            response(ProfileSwitchStatus.PROFILE_SWITCH_STATUS_CONFIRMATION_REQUIRED),
        )
        vi.mocked(StateServiceClient.confirmProfileSwitch).mockResolvedValueOnce(
            response(ProfileSwitchStatus.PROFILE_SWITCH_STATUS_SWITCHED, true),
        )
        await act(async () => result.current.requestSwitch("small-profile", ["act"]))
        expect(composer.retire).not.toHaveBeenCalled()
        await act(async () => result.current.confirmSwitch("profile-operation-1"))
        expect(composer.retire).toHaveBeenCalledOnce()
    })

    it("settles a confirmation against the draft its request carried, not the composer's later one", async () => {
        const composer = composerHolding()
        const sent = { text: "reply", images: [], files: [] }
        vi.mocked(StateServiceClient.requestProfileSwitch).mockResolvedValueOnce(
            response(ProfileSwitchStatus.PROFILE_SWITCH_STATUS_CONFIRMATION_REQUIRED),
        )
        vi.mocked(StateServiceClient.confirmProfileSwitch).mockResolvedValueOnce(
            response(ProfileSwitchStatus.PROFILE_SWITCH_STATUS_SWITCHED, true),
        )
        const { result, rerender } = renderHook(
            ({ draft }: { draft: typeof sent }) => useProfileSwitch({ profileSwitch: { phase: "idle" }, draft, composer }),
            { initialProps: { draft: sent } },
        )

        await act(async () => result.current.requestSwitch("small-profile", ["act"]))
        rerender({ draft: { text: "typed while the notice was open", images: [], files: [] } })
        await act(async () => result.current.confirmSwitch("profile-operation-1"))

        expect(composer.holds).toHaveBeenCalledWith(sent)
        expect(composer.retire).toHaveBeenCalledOnce()
    })

    it("leaves a composer the user edited after the request alone", async () => {
        const composer = composerHolding(false)
        vi.mocked(StateServiceClient.requestProfileSwitch).mockResolvedValueOnce(
            response(ProfileSwitchStatus.PROFILE_SWITCH_STATUS_CONFIRMATION_REQUIRED),
        )
        vi.mocked(StateServiceClient.confirmProfileSwitch).mockResolvedValueOnce(
            response(ProfileSwitchStatus.PROFILE_SWITCH_STATUS_SWITCHED, true),
        )
        const { result } = renderHook(() =>
            useProfileSwitch({ profileSwitch: { phase: "idle" }, draft: { text: "reply", images: [], files: [] }, composer }),
        )

        await act(async () => result.current.requestSwitch("small-profile", ["act"]))
        await act(async () => result.current.confirmSwitch("profile-operation-1"))

        expect(composer.retire).not.toHaveBeenCalled()
    })

    it("keeps the draft when a delivered flag accompanies a refused switch", async () => {
        const composer = composerHolding()
        vi.mocked(StateServiceClient.requestProfileSwitch).mockResolvedValueOnce(
            ProfileSwitchResponse.create({
                status: ProfileSwitchStatus.PROFILE_SWITCH_STATUS_REJECTED,
                operationId: "profile-operation-1",
                draftDelivered: true,
            }),
        )
        const { result } = renderHook(() =>
            useProfileSwitch({
                profileSwitch: { phase: "idle" },
                draft: { text: "reply", images: [], files: [] },
                composer,
            }),
        )

        await act(async () => result.current.requestSwitch("small-profile", ["act"]))

        expect(composer.retire).not.toHaveBeenCalled()
    })

    it("confirms and cancels by immutable operation identity", async () => {
        const { result } = renderHook(() => useProfileSwitch({ profileSwitch: snapshot("awaiting_confirmation") }))

        await act(async () => result.current.confirmSwitch("profile-operation-1"))
        await act(async () => result.current.cancelSwitch("profile-operation-1"))

        expect(StateServiceClient.confirmProfileSwitch).toHaveBeenCalledWith(
            expect.objectContaining({ operationId: "profile-operation-1" }),
        )
        expect(StateServiceClient.cancelProfileSwitch).toHaveBeenCalledWith(
            expect.objectContaining({ operationId: "profile-operation-1" }),
        )
    })
})
