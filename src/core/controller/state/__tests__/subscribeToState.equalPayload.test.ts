import type { ExtensionState } from "@shared/ExtensionMessage"
import { beforeEach, describe, expect, it } from "vitest"
import type { Controller } from "../../index"
import { cleanupStateSubscriptions, sendStateUpdate, subscribeToState } from "../subscribeToState"

/**
 * Behavior guard for delivering a payload that carries no change.
 *
 * A durable message boundary republishes the whole state even when nothing
 * changed, and an idle task produces a steady stream of them. Every delivery
 * costs each subscriber a full parse and re-render, so an identical payload is
 * dropped before it reaches the stream.
 *
 * The top-level `stateRevision` advances on every build and only lets the
 * Webview reject an out-of-order snapshot, so it is excluded from the
 * comparison. `taskViewState.stateRevision` is not excluded: the interaction
 * host uses it to decide what it may act on.
 */

interface StreamedPayload {
	stateJson: string
}

function createState(overrides: Partial<ExtensionState> = {}): ExtensionState {
	return {
		stateRevision: 1,
		isNewUser: false,
		welcomeViewCompleted: true,
		onboardingModels: undefined,
		...overrides,
	} as ExtensionState
}

function createController(): Controller {
	return {
		isUiAttached: () => true,
		getAccountUsage: () => undefined,
		task: undefined,
	} as unknown as Controller
}

/** Subscribe one stream and return everything it receives. */
async function attachSubscriber(controller: Controller, state: ExtensionState): Promise<StreamedPayload[]> {
	const received: StreamedPayload[] = []
	const target = controller as unknown as {
		getStateToPostToWebview(): Promise<ExtensionState>
		isStateCurrent(revision: number): boolean
		ensureWorkspaceManager?: () => Promise<void>
	}
	target.getStateToPostToWebview = async () => state
	target.isStateCurrent = () => true

	await subscribeToState(
		controller,
		{} as never,
		async (payload: StreamedPayload) => {
			received.push(payload)
		},
		"request-1",
	)
	return received
}

describe("state delivery equality guard", () => {
	let controller: Controller

	beforeEach(() => {
		controller = createController()
	})

	it("delivers the first payload", async () => {
		const state = createState()
		const received = await attachSubscriber(controller, state)

		await sendStateUpdate(controller, createState({ stateRevision: 2 }), undefined, { immediate: true })

		expect(received.length).toBeGreaterThanOrEqual(1)
		cleanupStateSubscriptions(controller)
	})

	it("drops a payload that differs only by the top-level revision", async () => {
		const state = createState()
		const received = await attachSubscriber(controller, state)
		await sendStateUpdate(controller, createState({ stateRevision: 2 }), undefined, { immediate: true })
		const afterFirst = received.length

		await sendStateUpdate(controller, createState({ stateRevision: 3 }), undefined, { immediate: true })

		expect(received.length).toBe(afterFirst)
		cleanupStateSubscriptions(controller)
	})

	it("delivers a payload whose task view revision changed", async () => {
		const received = await attachSubscriber(controller, createState())
		await sendStateUpdate(
			controller,
			createState({ stateRevision: 2, taskViewState: { taskId: "t", stateRevision: 10 } as never }),
			undefined,
			{ immediate: true },
		)
		const afterFirst = received.length

		// Only the nested revision moves: the interaction host acts on it, so
		// excluding it would strand the Webview on a superseded projection.
		await sendStateUpdate(
			controller,
			createState({ stateRevision: 3, taskViewState: { taskId: "t", stateRevision: 11 } as never }),
			undefined,
			{ immediate: true },
		)

		expect(received.length).toBe(afterFirst + 1)
		cleanupStateSubscriptions(controller)
	})

	it("delivers again after a real change", async () => {
		const received = await attachSubscriber(controller, createState())
		await sendStateUpdate(controller, createState({ stateRevision: 2 }), undefined, { immediate: true })
		const afterFirst = received.length

		await sendStateUpdate(controller, createState({ stateRevision: 3, isNewUser: true }), undefined, { immediate: true })

		expect(received.length).toBe(afterFirst + 1)
		cleanupStateSubscriptions(controller)
	})

	it("forgets the delivered payload once the controller detaches", async () => {
		const received = await attachSubscriber(controller, createState())
		await sendStateUpdate(controller, createState({ stateRevision: 2 }), undefined, { immediate: true })
		const afterFirst = received.length

		cleanupStateSubscriptions(controller)
		const reattached = await attachSubscriber(controller, createState())
		await sendStateUpdate(controller, createState({ stateRevision: 2 }), undefined, { immediate: true })

		expect(received.length).toBe(afterFirst)
		expect(reattached.length).toBeGreaterThanOrEqual(1)
		cleanupStateSubscriptions(controller)
	})
})
