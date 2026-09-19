import type { AccountUsage } from "@core/api"
import { EmptyRequest } from "@shared/proto/dline/common"
import { State } from "@shared/proto/dline/state"
import { accountUsageToProto } from "@shared/proto-conversions/account-usage-conversion"
import { telemetryService } from "@/services/telemetry"
import { ExtensionState } from "@/shared/ExtensionMessage"
import { Logger } from "@/shared/services/Logger"
import { getRequestRegistry, StreamingResponseHandler } from "../grpc-handler"
import { Controller } from "../index"
import { degradeOversizedState } from "./stateSizeGuard"
import { formatStateSizeBreakdown, measureStateFieldSizes } from "./stateSizeProbe"

// Per-controller subscription sets to isolate state updates between
// independent webviews (sidebar vs. editor panels). Each Controller
// only pushes state to its own subscribers.
const controllerSubscriptions = new Map<Controller, Set<StreamingResponseHandler<State>>>()

// Debounce state is now per-controller so rapid-fire updates from one
// task don't flood a different task's webview.
type PendingUpdate = {
	state: ExtensionState
	accountUsage: AccountUsage | undefined
}
const pendingUpdates = new Map<Controller, PendingUpdate>()
const debounceTimers = new Map<Controller, ReturnType<typeof setTimeout>>()
const controllerSendChains = new Map<Controller, Promise<void>>()
const SLOW_STATE_OPERATION_MS = 100
/**
 * Total serialized size above which a payload is attributed field by field.
 *
 * The breakdown costs about as much as serializing the state again, so it is
 * reserved for payloads already far outside the normal range: an ordinary push
 * is orders of magnitude below this, while the pushes under investigation were
 * around 12.5 MB.
 */
const STATE_SIZE_PROBE_THRESHOLD_BYTES = 2 * 1024 * 1024

export interface StateSubscriptionCleanupResult {
	subscriberCount: number
	hadPendingUpdate: boolean
	hadDebounceTimer: boolean
	hadSendChain: boolean
}

type StateUpdateOptions = {
	immediate?: boolean
}

/**
 * Subscribe to state updates for a specific controller.
 * Only state from this controller will be sent to the given responseStream.
 *
 * @param controller The controller instance (acts as subscription owner)
 * @param _request The empty request
 * @param responseStream The streaming response handler
 * @param requestId The ID of the request (passed by the gRPC handler)
 */
export async function subscribeToState(
	controller: Controller,
	_request: EmptyRequest,
	responseStream: StreamingResponseHandler<State>,
	requestId?: string,
): Promise<void> {
	// Get or create the subscription set for this controller
	let subs = controllerSubscriptions.get(controller)
	if (!controller.isUiAttached()) return
	if (!subs) {
		subs = new Set()
		controllerSubscriptions.set(controller, subs)
	}
	subs.add(responseStream)

	// Register cleanup when the connection is closed
	const cleanup = () => {
		const set = controllerSubscriptions.get(controller)
		if (set) {
			set.delete(responseStream)
			if (set.size === 0) {
				controllerSubscriptions.delete(controller)
				pendingUpdates.delete(controller)
				const timer = debounceTimers.get(controller)
				if (timer) {
					clearTimeout(timer)
					debounceTimers.delete(controller)
				}
			}
		}
	}

	// Register the cleanup function with the request registry if we have a requestId
	if (requestId) {
		getRequestRegistry().registerRequest(requestId, cleanup, { type: "state_subscription" }, responseStream)
	}

	// E2E-only: deterministically overtake the first snapshot with an unsent build.
	const forceStaleInitialState = process.env.E2E_TEST === "true" && process.env.DLINE_E2E_FORCE_STALE_INITIAL_STATE === "true"
	if (typeof controller.ensureWorkspaceManager === "function") {
		await controller.ensureWorkspaceManager()
	}
	if (!controller.isUiAttached()) {
		cleanup()
		return
	}
	let initialState = await controller.getStateToPostToWebview()
	if (!controller.isUiAttached()) {
		cleanup()
		return
	}
	if (forceStaleInitialState) {
		const overtakingState = await controller.getStateToPostToWebview()
		Logger.log(
			`[E2E state hydration race] Overtook revision ${initialState.stateRevision} with ${overtakingState.stateRevision}`,
		)
	}
	while (!controller.isStateCurrent(initialState.stateRevision)) {
		initialState = await controller.getStateToPostToWebview()
		if (!controller.isUiAttached()) {
			cleanup()
			return
		}
	}
	if (!controller.isUiAttached()) {
		cleanup()
		return
	}
	const initialStateJson = JSON.stringify(initialState)
	const accountUsage = controller.getAccountUsage()

	recordStateSizeTelemetry(Buffer.byteLength(initialStateJson, "utf8"))

	try {
		await responseStream(
			{
				stateJson: initialStateJson,
				accountUsage: accountUsageToProto(accountUsage),
			},
			false, // Not the last message
		)
		if (forceStaleInitialState) {
			Logger.log(`[E2E state hydration race] Delivered initial revision ${initialState.stateRevision}`)
		}
	} catch (error) {
		Logger.error("Error sending initial state:", error)
		cleanup()
	}
}

/**
 * Send a state update to a specific controller's subscribers.
 * Only webviews subscribed to this controller receive the update.
 *
 * @param controller The controller whose subscribers should receive the update
 * @param state The state to send
 * @param accountUsage Optional account usage data
 * @param options Debounce / immediate options
 */
/** Remove every state-delivery resource owned by one detached controller. */
export function cleanupStateSubscriptions(controller: Controller): StateSubscriptionCleanupResult {
	const subscriptions = controllerSubscriptions.get(controller)
	const timer = debounceTimers.get(controller)
	const result = {
		subscriberCount: subscriptions?.size ?? 0,
		hadPendingUpdate: pendingUpdates.has(controller),
		hadDebounceTimer: timer !== undefined,
		hadSendChain: controllerSendChains.has(controller),
	}
	if (timer) clearTimeout(timer)
	subscriptions?.clear()
	controllerSubscriptions.delete(controller)
	pendingUpdates.delete(controller)
	debounceTimers.delete(controller)
	controllerSendChains.delete(controller)
	// A later subscriber needs a full payload, so the equality guard must not
	// remember what a detached one already received.
	lastDeliveredPayloads.delete(controller)
	return result
}

export async function sendStateUpdate(
	controller: Controller,
	state: ExtensionState,
	accountUsage?: AccountUsage,
	options?: StateUpdateOptions,
): Promise<void> {
	if (!controller.isUiAttached()) return
	pendingUpdates.set(controller, { state, accountUsage })

	if (options?.immediate) {
		const timer = debounceTimers.get(controller)
		if (timer) {
			clearTimeout(timer)
			debounceTimers.delete(controller)
		}

		const pending = pendingUpdates.get(controller)
		if (pending) {
			pendingUpdates.delete(controller)
			await sendStateToSubscribers(controller, pending.state, pending.accountUsage)
		}
		return
	}

	if (debounceTimers.has(controller)) {
		return // debounce in progress, latest state will be sent when timer fires
	}

	debounceTimers.set(
		controller,
		setTimeout(async () => {
			debounceTimers.delete(controller)
			if (!controller.isUiAttached()) {
				pendingUpdates.delete(controller)
				return
			}
			const pending = pendingUpdates.get(controller)
			if (pending) {
				pendingUpdates.delete(controller)
				await sendStateToSubscribers(controller, pending.state, pending.accountUsage)
			}
		}, 50),
	)
}

/** Send an account-usage-only event without rebuilding or serializing ExtensionState. */
export async function sendAccountUsageUpdate(controller: Controller, accountUsage?: AccountUsage): Promise<void> {
	if (!controller.isUiAttached()) return
	await enqueueControllerSend(controller, async () => {
		await sendPayloadToSubscribers(controller, "", accountUsage)
	})
}

/** A monotonic partial state update applied only after the Webview has hydrated a full snapshot. */
export type ExtensionStatePatch = {
	__dlineStatePatch: true
	stateRevision: number
} & Partial<Omit<ExtensionState, "stateRevision">>

/**
 * Send a small interaction-critical patch without waiting behind a full state build or delivery queue.
 * Older full snapshots may still arrive, but the Webview rejects them by `stateRevision`.
 */
export async function sendStatePatch(
	controller: Controller,
	patch: Omit<ExtensionStatePatch, "__dlineStatePatch">,
	accountUsage?: AccountUsage,
): Promise<void> {
	if (!controller.isUiAttached()) return
	const payload: ExtensionStatePatch = { ...patch, __dlineStatePatch: true }
	const stateJson = JSON.stringify(payload)
	const stateSizeBytes = Buffer.byteLength(stateJson, "utf8")
	recordStateSizeTelemetry(stateSizeBytes)
	await sendPayloadToSubscribers(controller, stateJson, accountUsage, stateSizeBytes)
}

/**
 * Serialized form of the last payload delivered to a controller's subscribers.
 *
 * The top-level `stateRevision` advances on every build, so it is replaced by a
 * constant before comparison: it only lets the Webview reject an out-of-order
 * snapshot and is not a value the UI renders. Every other field participates,
 * including `taskViewState.stateRevision`, which the interaction host does use
 * to decide what it is allowed to act on.
 */
const lastDeliveredPayloads = new WeakMap<Controller, string>()

/** Neutralize the revision that changes on every build, leaving the rest intact. */
function stateIdentity(state: ExtensionState): string {
	return JSON.stringify({ ...state, stateRevision: 0 })
}

async function sendStateToSubscribers(
	controller: Controller,
	state: ExtensionState,
	finalAccountUsage?: AccountUsage,
): Promise<void> {
	try {
		const serializationStartedAtMs = performance.now()
		const stateJson = JSON.stringify(state)
		const serializationMs = Math.round(performance.now() - serializationStartedAtMs)
		const stateSizeBytes = Buffer.byteLength(stateJson, "utf8")
		if (serializationMs >= SLOW_STATE_OPERATION_MS) {
			let activeTasks = 1
			try {
				const { OrchestratorController } = await import("@/core/orchestrator/OrchestratorController")
				activeTasks = OrchestratorController.getInstance().getControllerCount()
			} catch {
				// Unit and CLI contexts may not initialize the VS Code orchestrator.
			}
			Logger.debug(
				`[StateUpdate] serialization timing: taskId=${controller.task?.taskId ?? "none"}, serializationMs=${serializationMs}, sizeBytes=${stateSizeBytes}, activeTasks=${activeTasks}`,
			)
		}
		// A durable message boundary republishes the whole state even when it
		// carries no change, and an idle task produces a steady stream of them.
		// Delivering an identical payload costs every subscriber a full parse
		// and re-render for nothing.
		const identity = stateIdentity(state)
		if (lastDeliveredPayloads.get(controller) === identity) return
		lastDeliveredPayloads.set(controller, identity)

		recordStateSizeTelemetry(stateSizeBytes)
		reportOversizedState(controller, state, stateSizeBytes)

		// Bounding the field that was found does not prevent the next unbounded
		// one, and a payload this size occupies the host main thread for as long
		// as it takes to serialize. Degrade rather than drop: a webview that
		// receives nothing renders a blank panel.
		const { state: payload, droppedFields } = degradeOversizedState(state, stateSizeBytes)
		let payloadJson = stateJson
		let payloadBytes = stateSizeBytes
		if (droppedFields.length > 0) {
			// Re-serialize, or the oversized JSON would still be the one sent.
			payloadJson = JSON.stringify(payload)
			payloadBytes = Buffer.byteLength(payloadJson, "utf8")
			Logger.warn(
				`[StateUpdate] degraded oversized state: taskId=${controller.task?.taskId ?? "none"}, ` +
					`originalBytes=${stateSizeBytes}, sentBytes=${payloadBytes}, dropped=${droppedFields.join(",")}`,
			)
		}

		await enqueueControllerSend(controller, async () => {
			await sendPayloadToSubscribers(controller, payloadJson, finalAccountUsage, payloadBytes)
		})
	} catch (error) {
		Logger.error("Error serializing state update:", error)
	}
}

function enqueueControllerSend(controller: Controller, send: () => Promise<void>): Promise<void> {
	const previous = controllerSendChains.get(controller) ?? Promise.resolve()
	const next = previous.then(send, send)
	controllerSendChains.set(controller, next)
	return next.finally(() => {
		if (controllerSendChains.get(controller) === next) {
			controllerSendChains.delete(controller)
		}
	})
}

async function sendPayloadToSubscribers(
	controller: Controller,
	stateJson: string,
	accountUsage?: AccountUsage,
	stateSizeBytes = 0,
): Promise<void> {
	const startTime = performance.now()
	const subs = controllerSubscriptions.get(controller)
	if (!subs || subs.size === 0) return

	await Promise.all(
		Array.from(subs).map(async (responseStream) => {
			try {
				await responseStream({ stateJson, accountUsage: accountUsageToProto(accountUsage) }, false)
			} catch (error) {
				Logger.error("Error sending state update:", error)
				subs.delete(responseStream)
			}
		}),
	)

	const durationMs = Math.round(performance.now() - startTime)
	if (durationMs >= SLOW_STATE_OPERATION_MS) {
		Logger.debug(
			`[StateUpdate] delivery timing: taskId=${controller.task?.taskId ?? "none"}, deliveryMs=${durationMs}, sizeBytes=${stateSizeBytes}, subscribers=${subs.size}`,
		)
	}
}

function recordStateSizeTelemetry(sizeBytes: number): void {
	telemetryService.captureGrpcResponseSize(sizeBytes, "cline.StateService", "subscribeToState")
}

/**
 * Names the field responsible for a payload that is far outside normal size.
 *
 * Total size alone says a push is too large but not what to fix, and with
 * several tasks broadcasting at once that attribution is what decides whether
 * a fix targets the right field.
 */
function reportOversizedState(controller: Controller, state: ExtensionState, stateSizeBytes: number): void {
	if (stateSizeBytes < STATE_SIZE_PROBE_THRESHOLD_BYTES) {
		return
	}
	const breakdown = measureStateFieldSizes(state, stateSizeBytes)
	Logger.warn(
		`[StateUpdate] oversized state: taskId=${controller.task?.taskId ?? "none"} ${formatStateSizeBreakdown(breakdown)}`,
	)
}
