import { createInitialTaskState, type TaskState } from "@core/task/kernel"
import { type ContextWindowIndicatorSnapshot, getContextWindowIndicatorTotalTokens } from "@shared/context-window-indicator"
import type { Mode } from "@shared/storage/types"
import { describe, expect, it, vi } from "vitest"
import {
	type ContextUsageScope,
	type ContextUsageTarget,
	isRunAtRest,
	TaskContextUsageProjection,
	type TaskContextUsageProjectionOptions,
} from "../TaskContextUsageProjection"

const WINDOW = 1_000_000

function createProjection(mode: Mode = "act", options: Pick<TaskContextUsageProjectionOptions, "settled" | "restored"> = {}) {
	const target: ContextUsageTarget = {}
	const publish = vi.fn(async () => {})
	let scope: ContextUsageScope = { mode, profileId: "profile-source", profileName: "Source", contextWindow: WINDOW }
	const projection = new TaskContextUsageProjection({ taskId: "task-1", target, scope: () => scope, publish, ...options })
	const switchTo = (next: ContextUsageScope) => {
		scope = next
	}
	return { target, publish, projection, switchTo }
}

function running(): TaskState {
	return { ...createInitialTaskState("task-1"), flow: { phase: "running" } }
}

function awaiting(kind: string): TaskState {
	return {
		...running(),
		dialog: {
			approvalsByBlock: {},
			primary: {
				interactionId: "interaction-1",
				turnId: "turn-1",
				kind,
				status: "awaiting",
				createdRevision: 1,
				presentationRef: "presentation-1",
				actionRules: [],
			},
		},
	} as TaskState
}

/** Publication is best effort and ordered behind earlier redraws, so tests let it drain. */
const drained = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

async function request(harness: ReturnType<typeof createProjection>, turnId: string, contextTokens: number, outputTokens = 0) {
	await harness.projection.started({ turnId, contextWindow: WINDOW })
	await harness.projection.record({ turnId, contextTokens, outputTokens, contextWindow: WINDOW })
	await drained()
}

function total(harness: ReturnType<typeof createProjection>): number | undefined {
	const snapshot = harness.target.contextWindowIndicator
	return snapshot && getContextWindowIndicatorTotalTokens(snapshot)
}

describe("TaskContextUsageProjection", () => {
	it("shows a request as sending until it reports, then as receiving", async () => {
		const harness = createProjection()

		await harness.projection.started({ turnId: "turn-1", contextWindow: WINDOW })
		expect(harness.target.contextWindowIndicator).toMatchObject({ phase: "sending", contextWindow: WINDOW, mode: "act" })

		await harness.projection.record({ turnId: "turn-1", contextTokens: 630_100, outputTokens: 0, contextWindow: WINDOW })
		expect(harness.target.contextWindowIndicator).toMatchObject({ taskId: "task-1", phase: "receiving" })
		expect(total(harness)).toBe(630_100)
		// The header only redraws on a published state, so a snapshot that is
		// written but never published is as good as missing.
		await drained()
		expect(harness.publish).toHaveBeenCalledTimes(2)
	})

	it("shows the response as received and makes the round's input durable for the next request", async () => {
		const harness = createProjection()
		await request(harness, "turn-1", 6_100, 100)

		harness.projection.committed(awaiting("qna_response"))
		expect(harness.target.contextWindowIndicator).toMatchObject({
			phase: "receiving",
			durableContextTokens: 0,
			receivingTokens: 100,
			stagedTokens: 6_000,
		})

		await harness.projection.started({ turnId: "turn-2", contextWindow: WINDOW })
		expect(harness.target.contextWindowIndicator).toMatchObject({ phase: "sending", durableContextTokens: 6_000 })

		await harness.projection.record({ turnId: "turn-2", contextTokens: 6_600, outputTokens: 100, contextWindow: WINDOW })
		expect(harness.target.contextWindowIndicator).toMatchObject({
			phase: "receiving",
			durableContextTokens: 6_000,
			receivingTokens: 100,
		})
		expect(total(harness)).toBe(6_600)
	})

	// Nothing is durable before a round completes, so the whole estimate except
	// the environment is the send in flight.
	it("opens the first request on the admitted estimate with no durable context yet", async () => {
		const harness = createProjection()

		await harness.projection.started({
			turnId: "turn-1",
			contextWindow: WINDOW,
			opening: {
				estimatedTokens: 5_500,
				projectedUsageTokens: 5_500,
				segments: { durableContextTokens: 5_000, pendingSendTokens: 300, environmentTokens: 200, totalTokens: 5_500 },
			},
		})

		expect(harness.target.contextWindowIndicator).toMatchObject({
			phase: "sending",
			durableContextTokens: 0,
			pendingSendTokens: 5_300,
			environmentTokens: 200,
		})
		expect(total(harness)).toBe(5_500)
	})

	it("opens a later request at its projected occupancy without subtracting the estimate from the reported figure", async () => {
		const harness = createProjection()
		await request(harness, "turn-1", 6_100, 100)
		harness.projection.committed(awaiting("qna_response"))

		await harness.projection.started({
			turnId: "turn-2",
			contextWindow: WINDOW,
			opening: {
				// A local estimate on another scale than the provider's count; only its environment is used.
				estimatedTokens: 90_000,
				projectedUsageTokens: 7_000,
				segments: { durableContextTokens: 89_000, pendingSendTokens: 800, environmentTokens: 200, totalTokens: 90_000 },
			},
		})

		expect(harness.target.contextWindowIndicator).toMatchObject({
			phase: "sending",
			durableContextTokens: 6_000,
			pendingSendTokens: 800,
			environmentTokens: 200,
		})
		expect(total(harness)).toBe(7_000)
	})

	it("shows a streaming response by the provider's figure before its final usage settles it", async () => {
		const harness = createProjection()
		await request(harness, "turn-1", 6_100, 100)
		const drawn: Array<string | undefined> = []
		harness.publish.mockImplementation(async () => {
			drawn.push(harness.target.contextWindowIndicator?.phase)
		})
		await harness.projection.started({ turnId: "turn-2", contextWindow: WINDOW })

		// Before the provider reports anything, the generated text is all there is to show.
		harness.projection.receiving({
			turnId: "turn-2",
			receivingTokens: 50,
			authoritativeContextTokens: 0,
			contextWindow: WINDOW,
		})
		await drained()
		// The first delta arrives before the view drew the request; it must not hide it.
		expect(drawn).toEqual(["sending", "receiving"])
		expect(harness.target.contextWindowIndicator).toMatchObject({ phase: "receiving", receivingTokens: 50 })
		expect(total(harness)).toBe(6_050)
		const redraws = harness.publish.mock.calls.length

		// Providers such as Anthropic report the input first; output is still an estimate.
		harness.projection.receiving({
			turnId: "turn-2",
			receivingTokens: 900,
			authoritativeContextTokens: 7_000,
			contextWindow: WINDOW,
		})
		// A request that is no longer in flight cannot move the figure.
		harness.projection.receiving({
			turnId: "turn-1",
			receivingTokens: 5,
			authoritativeContextTokens: 9_999,
			contextWindow: WINDOW,
		})
		// Deltas arrive faster than the view redraws, so one redraw carries them all.
		await drained()
		expect(harness.publish).toHaveBeenCalledTimes(redraws + 1)
		expect(harness.target.contextWindowIndicator).toMatchObject({
			phase: "receiving",
			durableContextTokens: 6_000,
			receivingTokens: 900,
		})
		expect(total(harness)).toBe(7_000)

		await harness.projection.record({ turnId: "turn-2", contextTokens: 7_800, outputTokens: 800, contextWindow: WINDOW })
		expect(harness.target.contextWindowIndicator).toMatchObject({ phase: "receiving", receivingTokens: 800 })
		expect(total(harness)).toBe(7_800)
	})

	it("keeps the figure in flight while a dialog of the same run awaits an answer", async () => {
		const harness = createProjection()
		await request(harness, "turn-1", 630_100)

		harness.projection.committed(awaiting("qna_response"))

		expect(harness.target.contextWindowIndicator?.phase).toBe("receiving")
	})

	it("settles the figure once the run offers its completion", async () => {
		const harness = createProjection()
		await request(harness, "turn-1", 630_100)
		harness.publish.mockClear()

		harness.projection.committed(awaiting("completion"))

		expect(harness.target.contextWindowIndicator?.phase).toBe("stable")
		expect(total(harness)).toBe(630_100)
		await drained()
		expect(harness.publish).toHaveBeenCalledTimes(1)
		// A settled figure is not redrawn by every later commit.
		harness.projection.committed(awaiting("completion"))
		await drained()
		expect(harness.publish).toHaveBeenCalledTimes(1)
	})

	it("never lets a failing view reject the request that reported the figure", async () => {
		const harness = createProjection()
		harness.publish.mockRejectedValue(new Error("view gone"))

		await expect(harness.projection.started({ turnId: "turn-1", contextWindow: WINDOW })).resolves.toBeUndefined()
		await expect(
			harness.projection.record({ turnId: "turn-1", contextTokens: 10, outputTokens: 0, contextWindow: WINDOW }),
		).resolves.toBeUndefined()
		await drained()
		expect(harness.target.contextWindowIndicator?.phase).toBe("receiving")
	})

	it("keeps a compaction in flight when an earlier request reports or ends late", async () => {
		const harness = createProjection()
		await request(harness, "turn-1", 80_100)
		harness.projection.committed({
			...running(),
			flow: {
				phase: "running",
				compaction: { compactionId: "c:1", attempt: "c:1:1", contextRef: "r", status: "scheduled" },
			},
		} as TaskState)

		await harness.projection.record({ turnId: "turn-1", contextTokens: 90_000, outputTokens: 0, contextWindow: WINDOW })
		await harness.projection.unmeasured({ turnId: "turn-1" })

		expect(harness.target.contextWindowIndicator).toMatchObject({ phase: "sending", lineage: { kind: "compaction_pass" } })
	})

	it("hands the figure back once a compaction ends while the run continues", async () => {
		const harness = createProjection()
		await request(harness, "turn-1", 80_100)
		const compaction = (status: "scheduled" | "completed") =>
			({
				...running(),
				flow: { phase: "running", compaction: { compactionId: "c:1", attempt: "c:1:1", contextRef: "r", status } },
			}) as TaskState
		harness.projection.committed(compaction("scheduled"))
		expect(harness.target.contextWindowIndicator?.phase).toBe("sending")

		// The run carries on after the summary lands; the request that carries
		// the condensed context must be able to replace the pre-compaction figure.
		harness.projection.committed(compaction("completed"))
		await request(harness, "turn-2", 1_200)

		expect(harness.target.contextWindowIndicator).toMatchObject({ phase: "receiving", lineage: { kind: "ordinary" } })
		expect(total(harness)).toBe(1_200)
	})

	it("shrinks when a later request reports a smaller context, as after a compaction", async () => {
		const harness = createProjection()

		await request(harness, "turn-1", 980_100)
		const before = harness.target.contextWindowIndicator
		await request(harness, "turn-2", 18_400)
		const after = harness.target.contextWindowIndicator

		expect(total(harness)).toBe(18_400)
		// A newer revision is what makes the Webview accept the smaller figure
		// instead of keeping the snapshot it already drew.
		expect(after?.revision).toBeGreaterThan(before?.revision ?? Number.POSITIVE_INFINITY)
	})

	it("leaves the previous figure standing when a request ends without one", async () => {
		const harness = createProjection()
		await request(harness, "turn-1", 630_100)
		harness.projection.committed({ ...running(), flow: { phase: "waiting" } })

		await harness.projection.started({ turnId: "turn-2", contextWindow: WINDOW })
		await harness.projection.unmeasured({ turnId: "turn-2" })

		expect(harness.target.contextWindowIndicator?.phase).toBe("stable")
		expect(total(harness)).toBe(630_100)
	})

	it("follows the window of the model that served the latest request", async () => {
		const harness = createProjection("plan")

		await harness.projection.started({ turnId: "turn-1", contextWindow: 200_000 })
		await harness.projection.record({ turnId: "turn-1", contextTokens: 10_000, outputTokens: 0, contextWindow: 200_000 })
		await request(harness, "turn-2", 12_000)

		expect(harness.target.contextWindowIndicator).toMatchObject({ contextWindow: WINDOW, mode: "plan" })
	})

	it("shows a scheduled compaction as sending and settles once it ends", async () => {
		const harness = createProjection()
		await request(harness, "turn-1", 80_100)
		const compaction = (status: "scheduled" | "running" | "completed") =>
			({
				...awaiting("qna_response"),
				flow: {
					phase: "running",
					compaction: { compactionId: "compaction:1", attempt: "compaction:1:1", contextRef: "ref-1", status },
				},
			}) as TaskState

		harness.projection.committed(compaction("scheduled"))
		expect(harness.target.contextWindowIndicator?.phase).toBe("sending")
		expect(harness.target.contextWindowIndicator?.durableContextTokens).toBeGreaterThan(50_000)
		const revision = harness.target.contextWindowIndicator?.revision
		// The same run moving from scheduled to running is not a second request.
		harness.projection.committed(compaction("running"))
		expect(harness.target.contextWindowIndicator?.revision).toBe(revision)

		harness.projection.committed({ ...compaction("completed"), flow: { phase: "waiting" } } as TaskState)
		expect(harness.target.contextWindowIndicator?.phase).toBe("stable")
	})

	it("shows a compaction as the reported context plus the tail the round added since", async () => {
		const harness = createProjection()
		await request(harness, "turn-1", 17_392)
		// The run continues after this report, so the figure is still receiving.
		await request(harness, "turn-2", 930_100)
		harness.projection.staged({ pendingContextTokens: 66_000 })
		const compaction = (attempt: string) =>
			({
				...running(),
				flow: {
					phase: "running",
					compaction: { compactionId: "compaction:1", attempt, contextRef: "ref-1", status: "scheduled" },
				},
			}) as TaskState

		harness.projection.committed(compaction("compaction:1:1"))
		expect(harness.target.contextWindowIndicator).toMatchObject({
			phase: "sending",
			lineage: { kind: "compaction_pass" },
			pendingSendTokens: 66_000,
		})
		expect(total(harness)).toBe(996_100)

		// A retried attempt starts from a figure that already carries the tail.
		harness.projection.committed(compaction("compaction:1:2"))
		expect(total(harness)).toBe(996_100)

		harness.projection.compacted({ contextTokens: 17_000, contextWindow: WINDOW })
		expect(total(harness)).toBe(17_000)
	})

	it("follows each accepted Pass of the shown compaction down and ignores a Pass of another run", async () => {
		const harness = createProjection()
		await request(harness, "turn-1", 930_100)
		harness.projection.committed({
			...running(),
			flow: {
				phase: "running",
				compaction: { compactionId: "compaction:1", attempt: "compaction:1:1", contextRef: "ref-1", status: "scheduled" },
			},
		} as TaskState)
		expect(total(harness)).toBe(930_100)

		const pass = { durableContextTokens: 400_000, pendingSendTokens: 2_000, environmentTokens: 3_000, contextWindow: WINDOW }
		harness.projection.compactionPassProjected("compaction:0", pass)
		expect(total(harness)).toBe(930_100)

		harness.projection.compactionPassProjected("compaction:1", pass)
		// Settling folds the Pass's pending tail into the durable figure.
		expect(harness.target.contextWindowIndicator).toMatchObject({
			phase: "stable",
			lineage: { kind: "compaction_pass", operationId: "compaction:1" },
			durableContextTokens: 402_000,
			pendingSendTokens: 0,
			environmentTokens: 3_000,
		})
		expect(total(harness)).toBe(405_000)

		// A later Pass condenses further, so the figure keeps following it down.
		harness.projection.compactionPassProjected("compaction:1", { ...pass, durableContextTokens: 150_000 })
		expect(total(harness)).toBe(155_000)
	})

	it("drops a staged tail once an ordinary request carries it", async () => {
		const harness = createProjection()
		await request(harness, "turn-1", 500_000)
		harness.projection.staged({ pendingContextTokens: 40_000 })
		await request(harness, "turn-2", 540_000)

		harness.projection.committed({
			...running(),
			flow: {
				phase: "running",
				compaction: { compactionId: "compaction:1", attempt: "compaction:1:1", contextRef: "ref-1", status: "scheduled" },
			},
		} as TaskState)

		expect(total(harness)).toBe(540_000)
	})

	it("names the Profile a request was sent under", async () => {
		const harness = createProjection()

		await harness.projection.started({ turnId: "turn-1", contextWindow: WINDOW })

		expect(harness.target.contextWindowIndicator).toMatchObject({ profileId: "profile-source", profileName: "Source" })
	})

	it("rescopes the settled figure to the Profile and window the task switched to", async () => {
		const harness = createProjection()
		await request(harness, "turn-1", 140_100)
		harness.projection.committed(awaiting("completion"))
		await drained()
		const before = harness.target.contextWindowIndicator
		harness.publish.mockClear()

		harness.switchTo({ mode: "act", profileId: "profile-target", profileName: "Target", contextWindow: 131_072 })
		harness.projection.rebound()

		expect(harness.target.contextWindowIndicator).toMatchObject({
			phase: "stable",
			profileId: "profile-target",
			profileName: "Target",
			contextWindow: 131_072,
		})
		// The conversation did not change, only the window it is measured against.
		expect(total(harness)).toBe(140_100)
		expect(harness.target.contextWindowIndicator?.revision).toBeGreaterThan(before?.revision ?? Number.POSITIVE_INFINITY)
		await drained()
		expect(harness.publish).toHaveBeenCalledTimes(1)

		// A rebuild that lands on the same scope is not a change worth redrawing.
		harness.projection.rebound()
		await drained()
		expect(harness.publish).toHaveBeenCalledTimes(1)
	})

	it("follows a Mode switch that keeps the Profile", async () => {
		const harness = createProjection("act")
		await request(harness, "turn-1", 50_000)

		harness.switchTo({ mode: "plan", profileId: "profile-source", profileName: "Source", contextWindow: WINDOW })
		harness.projection.rebound()

		expect(harness.target.contextWindowIndicator).toMatchObject({ mode: "plan", profileName: "Source" })
	})

	it("has nothing to rescope before the task sends its first request", async () => {
		const harness = createProjection()

		harness.projection.rebound()
		await drained()

		expect(harness.target.contextWindowIndicator).toBeUndefined()
		expect(harness.publish).not.toHaveBeenCalled()
	})

	it("settles on the condensed figure as soon as a summary lands, before the next request reports", async () => {
		const harness = createProjection()
		await request(harness, "turn-1", 800_000)
		const compacting = (status: "running" | "completed") =>
			({
				...running(),
				flow: { phase: "running", compaction: { compactionId: "c:1", attempt: "c:1:1", contextRef: "r", status } },
			}) as TaskState
		harness.projection.committed(compacting("running"))
		expect(harness.target.contextWindowIndicator?.phase).toBe("sending")

		harness.projection.compacted({ contextTokens: 120_000, contextWindow: WINDOW })
		expect(harness.target.contextWindowIndicator?.phase).toBe("stable")
		expect(total(harness)).toBe(120_000)

		// The run ending afterwards leaves the condensed figure, and the next request starts from it.
		harness.projection.committed(compacting("completed"))
		expect(total(harness)).toBe(120_000)
		await harness.projection.started({ turnId: "turn-2", contextWindow: WINDOW })
		expect(total(harness)).toBe(120_000)
	})

	it("keeps the full figure when a compaction ends without landing a summary", async () => {
		const harness = createProjection()
		await request(harness, "turn-1", 800_000)
		harness.projection.committed({
			...running(),
			flow: { phase: "running", compaction: { compactionId: "c:1", attempt: "c:1:1", contextRef: "r", status: "running" } },
		} as TaskState)
		harness.projection.committed(running())
		expect(harness.target.contextWindowIndicator?.phase).toBe("stable")
		expect(total(harness)).toBe(800_000)
	})

	it("opens the figure from a landed summary when no request has reported yet", () => {
		const harness = createProjection("plan")

		harness.projection.compacted({ contextTokens: 50_000, contextWindow: WINDOW })

		expect(harness.target.contextWindowIndicator).toMatchObject({ phase: "stable", mode: "plan", contextWindow: WINDOW })
		expect(total(harness)).toBe(50_000)
	})

	it("draws the figure a stopped task last showed until its first request reports", async () => {
		const harness = createProjection("act", { restored: stoppedFigure("task-1") })

		expect(harness.target.contextWindowIndicator).toMatchObject({
			phase: "stable",
			revision: 7,
			environmentTokens: 1_500,
			contextWindow: WINDOW,
		})
		expect(total(harness)).toBe(43_500)
		// The opening session publishes its first state itself.
		await drained()
		expect(harness.publish).not.toHaveBeenCalled()

		await request(harness, "turn-1", 50_000)
		expect(total(harness)).toBe(50_000)
	})

	it("draws nothing from a figure saved for another task", () => {
		const harness = createProjection("act", { restored: stoppedFigure("task-2") })

		expect(harness.target.contextWindowIndicator).toBeUndefined()
	})

	it("saves the figure once it settles as the resting context", async () => {
		const settled = vi.fn()
		const harness = createProjection("act", { settled })
		await request(harness, "turn-1", 6_100, 100)
		expect(settled).not.toHaveBeenCalled()

		const idle = { ...running(), flow: { phase: "idle" } } as TaskState
		harness.projection.committed(idle)
		expect(harness.target.contextWindowIndicator?.phase).toBe("stable")
		expect(settled).toHaveBeenCalledTimes(1)

		// A commit that leaves the figure as it was has nothing new to save.
		harness.projection.committed(idle)
		expect(settled).toHaveBeenCalledTimes(1)
	})

	it("treats only a stopped flow or an offered completion as a run at rest", () => {
		expect(isRunAtRest(running())).toBe(false)
		expect(isRunAtRest(awaiting("followup"))).toBe(false)
		expect(isRunAtRest(awaiting("completion"))).toBe(true)
		for (const phase of ["idle", "waiting", "paused", "completed", "error", "terminated"] as const) {
			expect(isRunAtRest({ ...running(), flow: { phase } } as TaskState)).toBe(true)
		}
	})
})

function stoppedFigure(taskId: string): ContextWindowIndicatorSnapshot {
	return {
		taskId,
		revision: 7,
		epoch: 3,
		phase: "stable",
		durableContextTokens: 40_000,
		pendingSendTokens: 0,
		receivingTokens: 0,
		stagedTokens: 2_000,
		environmentTokens: 1_500,
		contextWindow: WINDOW,
		mode: "act",
		updatedAt: 1,
		lineage: { kind: "baseline" },
	}
}
