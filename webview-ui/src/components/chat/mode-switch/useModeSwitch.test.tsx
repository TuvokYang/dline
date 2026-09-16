import type { ModeSwitchSnapshot } from "@shared/mode-switch"
import { ModeSwitchResponse, ModeSwitchStatus } from "@shared/proto/dline/state"
import type { Mode } from "@shared/storage/types"
import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { StateServiceClient } from "@/services/grpc-client"
import { type ModeSwitchDraft, shouldAttachModeSwitchDraft, useModeSwitch } from "./useModeSwitch"

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
	attachDraft: boolean
}

const DRAFT: ModeSwitchDraft = {
	text: "draft text",
	images: ["image-data"],
	files: ["file-path"],
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
	const clearDraft = vi.fn<() => void>()

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

	it("assigns mode-switch continuation drafts to the backend transaction", () => {
		expect(shouldAttachModeSwitchDraft("followup")).toBe(true)
		expect(shouldAttachModeSwitchDraft("make_plan")).toBe(true)
		expect(shouldAttachModeSwitchDraft("qna_respond")).toBe(true)
		expect(shouldAttachModeSwitchDraft("generate_report")).toBe(true)
		expect(shouldAttachModeSwitchDraft("status_acknowledgment")).toBe(true)
		expect(shouldAttachModeSwitchDraft("completion_result")).toBe(true)
		expect(shouldAttachModeSwitchDraft("api_req_failed")).toBe(false)
		expect(shouldAttachModeSwitchDraft(undefined)).toBe(false)
	})

	/** Preserve a backend-owned draft while user confirmation is pending. */
	it("does not clear draft when confirmation is required", async () => {
		const { result } = renderHook(
			(props: HookProps) =>
				useModeSwitch({
					...props,
					draft: DRAFT,
					onSend,
					clearDraft,
				}),
			{
				initialProps: { mode: "plan", stateRevision: 1, modeSwitch: { phase: "idle" }, attachDraft: true },
			},
		)

		await act(async () => result.current.requestSwitch("act"))

		expect(result.current.isSwitchPending).toBe(true)
		expect(clearDraft).not.toHaveBeenCalled()
		expect(onSend).not.toHaveBeenCalled()
		expect(StateServiceClient.togglePlanActModeProto).toHaveBeenCalledWith(
			expect.objectContaining({ chatContent: { message: "draft text", images: ["image-data"], files: ["file-path"] } }),
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
				attachDraft: false,
				onSend,
				clearDraft,
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
				attachDraft: false,
				onSend,
				clearDraft,
			}),
		)

		await act(async () => vi.advanceTimersByTimeAsync(10_000))

		expect(result.current.isSwitchPending).toBe(true)
	})

	/** Send a frontend-owned draft exactly once after a direct switch commits. */
	it("submits text images and files once after switched", async () => {
		vi.mocked(StateServiceClient.togglePlanActModeProto).mockResolvedValueOnce(
			createResponse(ModeSwitchStatus.MODE_SWITCH_STATUS_SWITCHED),
		)
		const { result, rerender } = renderHook(
			(props: HookProps) =>
				useModeSwitch({
					...props,
					draft: DRAFT,
					onSend,
					clearDraft,
				}),
			{
				initialProps: { mode: "plan", stateRevision: 1, modeSwitch: { phase: "idle" }, attachDraft: false },
			},
		)

		await act(async () => result.current.requestSwitch("act"))
		rerender({ mode: "act", stateRevision: 2, modeSwitch: { phase: "idle" }, attachDraft: false })

		await waitFor(() => expect(onSend).toHaveBeenCalledWith(DRAFT))
		rerender({ mode: "act", stateRevision: 3, modeSwitch: { phase: "idle" }, attachDraft: false })
		expect(onSend).toHaveBeenCalledTimes(1)
		expect(clearDraft).not.toHaveBeenCalled()
	})

	/** Clear a backend-owned completion draft without sending it a second time. */
	it("does not resubmit a completion draft after a direct switch", async () => {
		vi.mocked(StateServiceClient.togglePlanActModeProto).mockResolvedValueOnce(
			createResponse(ModeSwitchStatus.MODE_SWITCH_STATUS_SWITCHED),
		)
		const { result, rerender } = renderHook(
			(props: HookProps) =>
				useModeSwitch({
					...props,
					draft: DRAFT,
					onSend,
					clearDraft,
				}),
			{
				initialProps: { mode: "act", stateRevision: 1, modeSwitch: { phase: "idle" }, attachDraft: true },
			},
		)

		await act(async () => result.current.requestSwitch("plan"))
		rerender({ mode: "plan", stateRevision: 2, modeSwitch: { phase: "idle" }, attachDraft: true })

		await waitFor(() => expect(clearDraft).toHaveBeenCalledOnce())
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
					clearDraft,
				}),
			{
				initialProps: { mode: "plan", stateRevision: 1, modeSwitch: { phase: "idle" }, attachDraft: false },
			},
		)

		await act(async () => result.current.requestSwitch("act"))
		rerender({ mode: "act", stateRevision: 2, modeSwitch: { phase: "idle" }, attachDraft: false })

		await waitFor(() => expect(result.current.isSwitchPending).toBe(false))
		expect(onSend).not.toHaveBeenCalled()
		expect(clearDraft).not.toHaveBeenCalled()
	})

	/** Treat the canonical state stream as committed even when the unary response is delayed. */
	it("submits the draft when committed state arrives before the unary response", async () => {
		const response = createDeferred<ModeSwitchResponse>()
		vi.mocked(StateServiceClient.togglePlanActModeProto).mockReturnValueOnce(response.promise)
		const { result, rerender } = renderHook(
			(props: HookProps) => useModeSwitch({ ...props, draft: DRAFT, onSend, clearDraft }),
			{
				initialProps: { mode: "plan", stateRevision: 1, modeSwitch: { phase: "idle" }, attachDraft: false },
			},
		)

		let request!: Promise<void>
		await act(async () => {
			request = result.current.requestSwitch("act")
			await Promise.resolve()
		})
		rerender({ mode: "act", stateRevision: 2, modeSwitch: { phase: "idle" }, attachDraft: false })

		await waitFor(() => expect(onSend).toHaveBeenCalledWith(DRAFT))
		response.resolve(createResponse(ModeSwitchStatus.MODE_SWITCH_STATUS_SWITCHED))
		await act(async () => request)
		expect(onSend).toHaveBeenCalledTimes(1)
	})

	/** Bind backend draft ownership from confirmation state before the unary response returns. */
	it("does not resubmit a confirmed compaction draft when the unary response is delayed", async () => {
		const response = createDeferred<ModeSwitchResponse>()
		vi.mocked(StateServiceClient.togglePlanActModeProto).mockReturnValueOnce(response.promise)
		const { result, rerender } = renderHook(
			(props: HookProps) => useModeSwitch({ ...props, draft: DRAFT, onSend, clearDraft }),
			{
				initialProps: { mode: "plan", stateRevision: 1, modeSwitch: { phase: "idle" }, attachDraft: false },
			},
		)

		let request!: Promise<void>
		await act(async () => {
			request = result.current.requestSwitch("act")
			await Promise.resolve()
		})
		rerender({
			mode: "plan",
			stateRevision: 2,
			modeSwitch: createSnapshot("awaiting_confirmation"),
			attachDraft: false,
		})
		rerender({ mode: "plan", stateRevision: 3, modeSwitch: createSnapshot("compacting"), attachDraft: false })
		rerender({ mode: "act", stateRevision: 4, modeSwitch: { phase: "idle" }, attachDraft: false })

		await waitFor(() => expect(clearDraft).toHaveBeenCalledOnce())
		expect(onSend).not.toHaveBeenCalled()
		response.resolve(createResponse(ModeSwitchStatus.MODE_SWITCH_STATUS_CONFIRMATION_REQUIRED))
		await act(async () => request)
		expect(clearDraft).toHaveBeenCalledTimes(1)
	})

	/** Let confirmed compaction consume a draft that was frontend-owned before the response. */
	it("clears rather than resubmits a draft after confirmed compaction", async () => {
		const { result, rerender } = renderHook(
			(props: HookProps) => useModeSwitch({ ...props, draft: DRAFT, onSend, clearDraft }),
			{
				initialProps: { mode: "plan", stateRevision: 1, modeSwitch: { phase: "idle" }, attachDraft: false },
			},
		)

		await act(async () => result.current.requestSwitch("act"))
		rerender({ mode: "plan", stateRevision: 2, modeSwitch: createSnapshot("compacting"), attachDraft: false })
		rerender({ mode: "act", stateRevision: 3, modeSwitch: { phase: "idle" }, attachDraft: false })

		await waitFor(() => expect(clearDraft).toHaveBeenCalledOnce())
		expect(onSend).not.toHaveBeenCalled()
	})

	/** Cancel only transaction metadata and preserve all input fields. */
	it("preserves draft after cancel", async () => {
		const { result } = renderHook(() =>
			useModeSwitch({
				mode: "plan",
				stateRevision: 2,
				modeSwitch: createSnapshot("awaiting_confirmation"),
				draft: DRAFT,
				attachDraft: true,
				onSend,
				clearDraft,
			}),
		)

		await act(async () => result.current.cancelSwitch("operation-1"))

		expect(clearDraft).not.toHaveBeenCalled()
		expect(onSend).not.toHaveBeenCalled()
		expect(StateServiceClient.cancelModeSwitch).toHaveBeenCalledTimes(1)
	})

	/** Preserve draft content when backend compaction enters a failed terminal state. */
	it("preserves draft after compact failure", async () => {
		const { result, rerender } = renderHook(
			(props: HookProps) => useModeSwitch({ ...props, draft: DRAFT, onSend, clearDraft }),
			{
				initialProps: { mode: "plan", stateRevision: 1, modeSwitch: { phase: "idle" }, attachDraft: true },
			},
		)
		await act(async () => result.current.requestSwitch("act"))

		rerender({
			mode: "plan",
			stateRevision: 2,
			modeSwitch: { ...createSnapshot("failed"), error: "Compaction failed." },
			attachDraft: true,
		})

		await waitFor(() => expect(result.current.isSwitchPending).toBe(false))
		expect(clearDraft).not.toHaveBeenCalled()
		expect(onSend).not.toHaveBeenCalled()
	})

	/** Ignore a terminal snapshot that belongs to a different operation identity. */
	it("ignores stale operation snapshots", async () => {
		const { result, rerender } = renderHook(
			(props: HookProps) => useModeSwitch({ ...props, draft: DRAFT, onSend, clearDraft }),
			{
				initialProps: { mode: "plan", stateRevision: 1, modeSwitch: { phase: "idle" }, attachDraft: false },
			},
		)
		await act(async () => result.current.requestSwitch("act"))

		rerender({
			mode: "plan",
			stateRevision: 2,
			modeSwitch: { ...createSnapshot("failed", "stale-operation"), error: "Stale failure." },
			attachDraft: false,
		})

		expect(result.current.isSwitchPending).toBe(true)
		expect(onSend).not.toHaveBeenCalled()
	})
})
