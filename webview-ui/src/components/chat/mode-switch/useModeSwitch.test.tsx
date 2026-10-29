import type { ModeSwitchSnapshot } from "@shared/mode-switch"
import { ModeSwitchResponse, ModeSwitchStatus } from "@shared/proto/dline/state"
import type { Mode } from "@shared/storage/types"
import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { StateServiceClient } from "@/services/grpc-client"
import { type ModeSwitchDraft, useModeSwitch } from "./useModeSwitch"

vi.mock("@/services/grpc-client", () => ({
    StateServiceClient: {
        togglePlanActModeProto: vi.fn(),
        confirmModeSwitch: vi.fn(),
        cancelModeSwitch: vi.fn(),
    },
}))

interface HookProps {
    mode: Mode
    stateRevision: number
    modeSwitch?: ModeSwitchSnapshot
}

// The captured draft carries its structure, so every assertion that the same
// draft is resubmitted also proves the composed nodes survive the switch.
const DRAFT: ModeSwitchDraft = {
    text: "draft text",
    images: ["image-data"],
    files: ["file-path"],
    semanticInput: {
        schemaVersion: 1,
        parserVersion: "1.0.0",
        catalogRevision: "3",
        documentId: "doc-mode-switch",
        rawText: "draft text",
        nodes: [{ kind: "text", text: "draft text" }],
        resources: [],
    },
}

/** Create a transaction snapshot for one operation and phase. */
function createSnapshot(phase: ModeSwitchSnapshot["phase"], operationId = "operation-1"): ModeSwitchSnapshot {
    return {
        phase,
        operationId,
        sourceMode: "plan",
        targetMode: "act",
    }
}

/** Create a typed mode-switch RPC response fixture. */
function createResponse(status: ModeSwitchStatus, operationId = "operation-1", error?: string): ModeSwitchResponse {
    return ModeSwitchResponse.create({ status, operationId, error })
}

/** A response reporting the switch done, with the backend's account of the draft it carried. */
function switchedResponse(draftDelivered: boolean): ModeSwitchResponse {
    return ModeSwitchResponse.create({
        status: ModeSwitchStatus.MODE_SWITCH_STATUS_SWITCHED,
        operationId: "operation-1",
        draftDelivered,
    })
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise
    })
    return { promise, resolve }
}

/** Verify draft ownership and transaction completion semantics without timeout fallbacks. */
describe("useModeSwitch", () => {
    const onSend = vi.fn<(draft: ModeSwitchDraft) => void>()
    // The composer still holds the captured draft unless a test says the user edited it.
    const composer = { holds: vi.fn<(draft: ModeSwitchDraft) => boolean>(() => true), retire: vi.fn<() => void>() }

    beforeEach(() => {
        vi.clearAllMocks()
        vi.mocked(StateServiceClient.togglePlanActModeProto).mockResolvedValue(
            createResponse(ModeSwitchStatus.MODE_SWITCH_STATUS_CONFIRMATION_REQUIRED),
        )
        vi.mocked(StateServiceClient.confirmModeSwitch).mockResolvedValue(
            createResponse(ModeSwitchStatus.MODE_SWITCH_STATUS_SWITCHED),
        )
        vi.mocked(StateServiceClient.cancelModeSwitch).mockResolvedValue(
            createResponse(ModeSwitchStatus.MODE_SWITCH_STATUS_REJECTED),
        )
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    /** Preserve a backend-owned draft while user confirmation is pending. */
    it("sends the composed draft and keeps it while confirmation is required", async () => {
        const { result } = renderHook(
            (props: HookProps) =>
                useModeSwitch({
                    ...props,
                    draft: DRAFT,
                    onSend,
                    composer,
                }),
            {
                initialProps: { mode: "plan", stateRevision: 1, modeSwitch: { phase: "idle" } },
            },
        )

        await act(async () => result.current.requestSwitch("act"))

        expect(result.current.isSwitchPending).toBe(true)
        expect(composer.retire).not.toHaveBeenCalled()
        expect(onSend).not.toHaveBeenCalled()
        expect(StateServiceClient.togglePlanActModeProto).toHaveBeenCalledWith(
            expect.objectContaining({
                chatContent: {
                    message: "draft text",
                    images: ["image-data"],
                    files: ["file-path"],
                    semanticInput: expect.objectContaining({ rawText: "draft text" }),
                },
            }),
        )
    })

    /** Keep the externally supplied source mode while backend compaction is active. */
    it("keeps source mode while compacting", () => {
        const { result } = renderHook(() =>
            useModeSwitch({
                mode: "plan",
                stateRevision: 2,
                modeSwitch: createSnapshot("compacting"),
                draft: DRAFT,
                onSend,
                composer,
            }),
        )

        expect(result.current.displayMode).toBe("plan")
        expect(result.current.isSwitchPending).toBe(true)
        expect(result.current.statusText).toBe("Compacting...")
    })

    /** Never release a compacting transaction because an arbitrary duration elapsed. */
    it("disables re-entry without any timeout", async () => {
        vi.useFakeTimers()
        const { result } = renderHook(() =>
            useModeSwitch({
                mode: "plan",
                stateRevision: 2,
                modeSwitch: createSnapshot("compacting"),
                draft: DRAFT,
                onSend,
                composer,
            }),
        )

        await act(async () => vi.advanceTimersByTimeAsync(10_000))

        expect(result.current.isSwitchPending).toBe(true)
    })

    /** Send a draft no dialog took exactly once after a direct switch commits. */
    it("submits an undelivered draft once after switched", async () => {
        vi.mocked(StateServiceClient.togglePlanActModeProto).mockResolvedValueOnce(switchedResponse(false))
        const { result, rerender } = renderHook(
            (props: HookProps) =>
                useModeSwitch({
                    ...props,
                    draft: DRAFT,
                    onSend,
                    composer,
                }),
            {
                initialProps: { mode: "plan", stateRevision: 1, modeSwitch: { phase: "idle" } },
            },
        )

        await act(async () => result.current.requestSwitch("act"))
        rerender({ mode: "act", stateRevision: 2, modeSwitch: { phase: "idle" } })

        await waitFor(() => expect(onSend).toHaveBeenCalledWith(DRAFT))
        rerender({ mode: "act", stateRevision: 3, modeSwitch: { phase: "idle" } })
        expect(onSend).toHaveBeenCalledTimes(1)
        expect(composer.retire).not.toHaveBeenCalled()
    })

    /** Clear a draft the awaiting dialog took without sending it a second time. */
    it("does not resubmit a draft the switch delivered", async () => {
        vi.mocked(StateServiceClient.togglePlanActModeProto).mockResolvedValueOnce(switchedResponse(true))
        const { result, rerender } = renderHook(
            (props: HookProps) =>
                useModeSwitch({
                    ...props,
                    draft: DRAFT,
                    onSend,
                    composer,
                }),
            {
                initialProps: { mode: "act", stateRevision: 1, modeSwitch: { phase: "idle" } },
            },
        )

        await act(async () => result.current.requestSwitch("plan"))
        rerender({ mode: "plan", stateRevision: 2, modeSwitch: { phase: "idle" } })

        await waitFor(() => expect(composer.retire).toHaveBeenCalledOnce())
        expect(onSend).not.toHaveBeenCalled()
    })

    /** Preserve a welcome-screen draft because only an explicit submit may create a Task. */
    it("keeps a welcome draft local after a direct switch", async () => {
        vi.mocked(StateServiceClient.togglePlanActModeProto).mockResolvedValueOnce(
            createResponse(ModeSwitchStatus.MODE_SWITCH_STATUS_SWITCHED),
        )
        const { result, rerender } = renderHook(
            (props: HookProps) =>
                useModeSwitch({
                    ...props,
                    draft: DRAFT,
                    submitDraftAfterSwitch: false,
                    onSend,
                    composer,
                }),
            {
                initialProps: { mode: "plan", stateRevision: 1, modeSwitch: { phase: "idle" } },
            },
        )

        await act(async () => result.current.requestSwitch("act"))
        rerender({ mode: "act", stateRevision: 2, modeSwitch: { phase: "idle" } })

        await waitFor(() => expect(result.current.isSwitchPending).toBe(false))
        expect(onSend).not.toHaveBeenCalled()
        expect(composer.retire).not.toHaveBeenCalled()
    })

    /**
     * The Mode change alone cannot say whether the dialog took the draft, so a
     * switch that carried one settles only on its own response.
     */
    it("waits for the switch's response when committed state arrives first", async () => {
        const response = createDeferred<ModeSwitchResponse>()
        vi.mocked(StateServiceClient.togglePlanActModeProto).mockReturnValueOnce(response.promise)
        const { result, rerender } = renderHook(
            (props: HookProps) => useModeSwitch({ ...props, draft: DRAFT, onSend, composer }),
            {
                initialProps: { mode: "plan", stateRevision: 1, modeSwitch: { phase: "idle" } },
            },
        )

        let request!: Promise<void>
        await act(async () => {
            request = result.current.requestSwitch("act")
            await Promise.resolve()
        })
        rerender({ mode: "act", stateRevision: 2, modeSwitch: { phase: "idle" } })
        expect(onSend).not.toHaveBeenCalled()
        expect(composer.retire).not.toHaveBeenCalled()
        expect(result.current.isSwitchPending).toBe(true)

        response.resolve(switchedResponse(false))
        await act(async () => request)
        await waitFor(() => expect(onSend).toHaveBeenCalledWith(DRAFT))
        expect(onSend).toHaveBeenCalledTimes(1)
        expect(composer.retire).not.toHaveBeenCalled()
    })

    /** A confirmed switch that delivered its draft lets the composer go and never resends it. */
    it("clears a draft that a confirmed switch delivered", async () => {
        vi.mocked(StateServiceClient.confirmModeSwitch).mockResolvedValueOnce(switchedResponse(true))
        const { result, rerender } = renderHook(
            (props: HookProps) => useModeSwitch({ ...props, draft: DRAFT, onSend, composer }),
            {
                initialProps: { mode: "plan", stateRevision: 1, modeSwitch: { phase: "idle" } },
            },
        )

        await act(async () => result.current.requestSwitch("act"))
        rerender({ mode: "plan", stateRevision: 2, modeSwitch: createSnapshot("awaiting_confirmation") })
        await act(async () => result.current.confirmSwitch("operation-1"))
        rerender({ mode: "plan", stateRevision: 3, modeSwitch: createSnapshot("compacting") })
        rerender({ mode: "act", stateRevision: 4, modeSwitch: { phase: "idle" } })

        await waitFor(() => expect(composer.retire).toHaveBeenCalledOnce())
        expect(onSend).not.toHaveBeenCalled()
    })

    /**
     * A confirmed switch with no dialog left to take the draft used to clear it
     * all the same; the draft is now sent as the user's next message instead.
     */
    it("sends a confirmed switch's undelivered draft instead of dropping it", async () => {
        vi.mocked(StateServiceClient.confirmModeSwitch).mockResolvedValueOnce(switchedResponse(false))
        const { result, rerender } = renderHook(
            (props: HookProps) => useModeSwitch({ ...props, draft: DRAFT, onSend, composer }),
            {
                initialProps: { mode: "plan", stateRevision: 1, modeSwitch: { phase: "idle" } },
            },
        )

        await act(async () => result.current.requestSwitch("act"))
        rerender({ mode: "plan", stateRevision: 2, modeSwitch: createSnapshot("compacting") })
        await act(async () => result.current.confirmSwitch("operation-1"))
        rerender({ mode: "act", stateRevision: 3, modeSwitch: { phase: "idle" } })

        await waitFor(() => expect(onSend).toHaveBeenCalledWith(DRAFT))
        expect(onSend).toHaveBeenCalledTimes(1)
        expect(composer.retire).not.toHaveBeenCalled()
    })

    /** Cancel only transaction metadata and preserve all input fields. */
    it("preserves draft after cancel", async () => {
        const { result } = renderHook(() =>
            useModeSwitch({
                mode: "plan",
                stateRevision: 2,
                modeSwitch: createSnapshot("awaiting_confirmation"),
                draft: DRAFT,
                onSend,
                composer,
            }),
        )

        await act(async () => result.current.cancelSwitch("operation-1"))

        expect(composer.retire).not.toHaveBeenCalled()
        expect(onSend).not.toHaveBeenCalled()
        expect(StateServiceClient.cancelModeSwitch).toHaveBeenCalledTimes(1)
    })

    /** Preserve draft content when backend compaction enters a failed terminal state. */
    it("preserves draft after compact failure", async () => {
        const { result, rerender } = renderHook(
            (props: HookProps) => useModeSwitch({ ...props, draft: DRAFT, onSend, composer }),
            {
                initialProps: { mode: "plan", stateRevision: 1, modeSwitch: { phase: "idle" } },
            },
        )
        await act(async () => result.current.requestSwitch("act"))

        rerender({
            mode: "plan",
            stateRevision: 2,
            modeSwitch: { ...createSnapshot("failed"), error: "Compaction failed." },
        })

        await waitFor(() => expect(result.current.isSwitchPending).toBe(false))
        expect(composer.retire).not.toHaveBeenCalled()
        expect(onSend).not.toHaveBeenCalled()
    })

    /** The user's edit after the switch started is newer work that neither a delivery nor a resend may touch. */
    it.each([true, false])("leaves an edited composer alone when the switch settles (delivered: %s)", async (delivered) => {
        vi.mocked(StateServiceClient.togglePlanActModeProto).mockResolvedValueOnce(switchedResponse(delivered))
        const { result, rerender } = renderHook(
            (props: HookProps) => useModeSwitch({ ...props, draft: DRAFT, onSend, composer }),
            {
                initialProps: { mode: "plan", stateRevision: 1, modeSwitch: { phase: "idle" } },
            },
        )

        await act(async () => result.current.requestSwitch("act"))
        composer.holds.mockReturnValue(false)
        rerender({ mode: "act", stateRevision: 2, modeSwitch: { phase: "idle" } })

        await waitFor(() => expect(result.current.isSwitchPending).toBe(false))
        expect(composer.holds).toHaveBeenCalledWith(DRAFT)
        expect(composer.retire).not.toHaveBeenCalled()
        expect(onSend).not.toHaveBeenCalled()
        composer.holds.mockReturnValue(true)
    })

    /** A request or confirmation answered without a settlement must not leave the toggle disabled forever. */
    it.each([
        ["request", ModeSwitchStatus.MODE_SWITCH_STATUS_IN_PROGRESS],
        ["confirmation", ModeSwitchStatus.MODE_SWITCH_STATUS_UNSPECIFIED],
    ])("releases a %s that ends without settling the draft", async (step, status) => {
        if (step === "request") {
            vi.mocked(StateServiceClient.togglePlanActModeProto).mockResolvedValueOnce(createResponse(status))
        } else {
            vi.mocked(StateServiceClient.confirmModeSwitch).mockResolvedValueOnce(createResponse(status))
        }
        const { result } = renderHook((props: HookProps) => useModeSwitch({ ...props, draft: DRAFT, onSend, composer }), {
            initialProps: { mode: "plan", stateRevision: 1, modeSwitch: { phase: "idle" } },
        })

        await act(async () => result.current.requestSwitch("act"))
        if (step === "confirmation") await act(async () => result.current.confirmSwitch("operation-1"))

        expect(result.current.isSwitchPending).toBe(false)
        expect(onSend).not.toHaveBeenCalled()
        expect(composer.retire).not.toHaveBeenCalled()
    })

    /** Ignore a terminal snapshot that belongs to a different operation identity. */
    it("ignores stale operation snapshots", async () => {
        const { result, rerender } = renderHook(
            (props: HookProps) => useModeSwitch({ ...props, draft: DRAFT, onSend, composer }),
            {
                initialProps: { mode: "plan", stateRevision: 1, modeSwitch: { phase: "idle" } },
            },
        )
        await act(async () => result.current.requestSwitch("act"))

        rerender({
            mode: "plan",
            stateRevision: 2,
            modeSwitch: { ...createSnapshot("failed", "stale-operation"), error: "Stale failure." },
        })

        expect(result.current.isSwitchPending).toBe(true)
        expect(onSend).not.toHaveBeenCalled()
    })
})
