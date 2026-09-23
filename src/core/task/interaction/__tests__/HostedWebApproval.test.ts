import { resolveWebSearchRoutingPlan } from "@core/api/server-tools"
import { ApiFormat, ServerTool } from "@shared/proto/dline/models/metadata"
import { describe, expect, it, vi } from "vitest"
import type { TaskEffectPorts } from "../../runtime/TaskEffectRunner"
import { TaskRuntime } from "../../runtime/TaskRuntime"
import { createTaskRuntimeState } from "../../runtime/TaskRuntimeState"
import { TaskPhase } from "../../TaskPhase"
import { hostedWebApprovalApiIndex, hostedWebCapabilityLabel, requestHostedWebApproval } from "../HostedWebApproval"
import { InteractionCoordinator, type InteractionOutcome } from "../InteractionCoordinator"

const HOSTED_WEB_PLAN = resolveWebSearchRoutingPlan({
	enabled: true,
	modelInfo: { capabilities: { tools: [ServerTool.WEB_SEARCH] } },
	selectedApiFormat: ApiFormat.OPENAI_RESPONSES,
	localAvailable: true,
	remoteAdapterAvailable: true,
})

function createPorts(appendAsk: TaskEffectPorts["appendAsk"]): TaskEffectPorts {
	return {
		postView: async () => {},
		persistSnapshot: async () => {},
		cancelRuntime: async () => {},
		prepareResume: async () => {},
		startApi: async () => {},
		executeTool: async () => {},
		appendSay: async () => {},
		appendAsk,
		startNewTask: async () => {},
	}
}

describe("Hosted Web Search request approval", () => {
	it("parses only this task's canonical non-negative request identity", () => {
		expect(hostedWebApprovalApiIndex("task-1", "hosted-web:task-1:0")).toBe(0)
		expect(hostedWebApprovalApiIndex("task-1", "hosted-web:task-1:42")).toBe(42)
		expect(hostedWebApprovalApiIndex("task-1", "hosted-web:task-2:0")).toBeUndefined()
		expect(hostedWebApprovalApiIndex("task-1", "hosted-web:task-1:-1")).toBeUndefined()
		expect(hostedWebApprovalApiIndex("task-1", "hosted-web:task-1:01")).toBeUndefined()
	})

	it("keeps the hosted route and blocks the Provider request until Use Web approval", async () => {
		expect(HOSTED_WEB_PLAN).toMatchObject({
			route: "hosted",
			localToolEnabled: false,
			serverTools: [ServerTool.WEB_SEARCH],
		})

		const appendAsk = vi.fn<TaskEffectPorts["appendAsk"]>(async () => ({ uiMessageTs: 100 }))
		const sendProviderRequest = vi.fn(async (_options: { serverTools: readonly ServerTool[] }) => undefined)
		const runtime = new TaskRuntime(
			createTaskRuntimeState({ taskId: "task-1", phase: TaskPhase.STREAMING, anchor: { apiIndex: 0 } }),
			createPorts(appendAsk),
		)
		const coordinator = new InteractionCoordinator(runtime)
		const interactionId = "hosted-web:task-1:0"

		const request = requestHostedWebApproval(coordinator, {
			taskId: "task-1",
			apiIndex: 0,
			providerId: "openai",
			routingPlan: HOSTED_WEB_PLAN,
			autoApproved: false,
		}).then(async (decision) => {
			if (!decision.approved) return "rejected" as const
			await sendProviderRequest({ serverTools: HOSTED_WEB_PLAN.serverTools })
			return "sent" as const
		})

		await vi.waitFor(() => expect(runtime.getState().interaction?.status).toBe("awaiting"))
		expect(runtime.getState()).toMatchObject({
			phase: TaskPhase.AWAITING_APPROVAL,
			anchor: { apiIndex: 0, turnId: interactionId, interactionId },
			interaction: { kind: "hosted_web_approval", interactionId, status: "awaiting" },
		})
		expect(appendAsk).toHaveBeenCalledWith(
			expect.objectContaining({
				taskAsk: "tool",
				interactionId,
				presentation: expect.stringContaining("provider-hosted Web Search"),
			}),
		)
		expect(sendProviderRequest).not.toHaveBeenCalled()

		const revision = runtime.getState().revision
		await coordinator.respond({
			taskId: "task-1",
			turnId: interactionId,
			interactionId,
			actionId: "approve",
			stateRevision: revision,
			draft: { text: "", images: [], files: [] },
		})

		await expect(request).resolves.toBe("sent")
		expect(sendProviderRequest).toHaveBeenCalledTimes(1)
		expect(sendProviderRequest).toHaveBeenCalledWith({ serverTools: [ServerTool.WEB_SEARCH] })
		expect(runtime.getState().interaction).toBeUndefined()
	})

	it("rejects the hosted request without sending or falling back to local Web Search", async () => {
		const sendProviderRequest = vi.fn(async (_options: { serverTools: readonly ServerTool[] }) => undefined)
		const runLocalSearch = vi.fn(async () => undefined)
		const runtime = new TaskRuntime(
			createTaskRuntimeState({ taskId: "task-1", phase: TaskPhase.STREAMING, anchor: { apiIndex: 3 } }),
			createPorts(async () => ({ uiMessageTs: 101 })),
		)
		const coordinator = new InteractionCoordinator(runtime)
		const interactionId = "hosted-web:task-1:3"

		const request = requestHostedWebApproval(coordinator, {
			taskId: "task-1",
			apiIndex: 3,
			providerId: "openai",
			routingPlan: HOSTED_WEB_PLAN,
			autoApproved: false,
		}).then(async (decision) => {
			if (!decision.approved) return "rejected" as const
			await sendProviderRequest({ serverTools: HOSTED_WEB_PLAN.serverTools })
			return "sent" as const
		})

		await vi.waitFor(() => expect(runtime.getState().interaction?.status).toBe("awaiting"))
		expect(sendProviderRequest).not.toHaveBeenCalled()
		expect(runLocalSearch).not.toHaveBeenCalled()

		await coordinator.respond({
			taskId: "task-1",
			turnId: interactionId,
			interactionId,
			actionId: "reject",
			stateRevision: runtime.getState().revision,
			draft: { text: "", images: [], files: [] },
		})

		await expect(request).resolves.toBe("rejected")
		expect(sendProviderRequest).not.toHaveBeenCalled()
		expect(runLocalSearch).not.toHaveBeenCalled()
		expect(HOSTED_WEB_PLAN.route).toBe("hosted")
		expect(runtime.getState()).toMatchObject({ phase: TaskPhase.PAUSED, interaction: undefined })
	})

	it("bypasses request approval only when Use Web auto-approves the hosted route", async () => {
		const open = vi.fn()

		await expect(
			requestHostedWebApproval(
				{ open },
				{
					taskId: "task-1",
					apiIndex: 4,
					providerId: "openai",
					routingPlan: HOSTED_WEB_PLAN,
					autoApproved: true,
				},
			),
		).resolves.toEqual({ required: false, approved: true })
		expect(open).not.toHaveBeenCalled()
	})

	it("requires request approval when only Web Fetch is hosted and names it in the card", async () => {
		const fetchOnlyPlan = resolveWebSearchRoutingPlan({
			enabled: true,
			modelInfo: { capabilities: { tools: [ServerTool.WEB_FETCH] } },
			selectedApiFormat: ApiFormat.ANTHROPIC_CHAT,
			localAvailable: true,
			remoteAdapterAvailable: true,
			remoteWebFetchAdapterAvailable: true,
		})
		expect(fetchOnlyPlan).toMatchObject({ route: "local", webFetchRoute: "hosted" })
		expect(hostedWebCapabilityLabel(fetchOnlyPlan)).toBe("Web Fetch")
		const open = vi.fn(async () => ({ actionId: "approve" }) as InteractionOutcome)

		await expect(
			requestHostedWebApproval(
				{ open },
				{
					taskId: "task-1",
					apiIndex: 6,
					providerId: "anthropic",
					routingPlan: fetchOnlyPlan,
					autoApproved: false,
				},
			),
		).resolves.toEqual({ required: true, approved: true })
		expect(open).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "hosted_web_approval",
				presentation: expect.stringContaining("Anthropic provider-hosted Web Fetch"),
			}),
		)
	})

	it("names both hosted web tools when search and fetch are hosted together", () => {
		const bothPlan = resolveWebSearchRoutingPlan({
			enabled: true,
			modelInfo: { capabilities: { tools: [ServerTool.WEB_SEARCH, ServerTool.WEB_FETCH] } },
			selectedApiFormat: ApiFormat.ANTHROPIC_CHAT,
			localAvailable: true,
			remoteAdapterAvailable: true,
			remoteWebFetchAdapterAvailable: true,
		})

		expect(hostedWebCapabilityLabel(bothPlan)).toBe("Web Search and Web Fetch")
		expect(hostedWebCapabilityLabel(HOSTED_WEB_PLAN)).toBe("Web Search")
	})

	it("does not apply the hosted request gate to a local route", async () => {
		const open = vi.fn()
		const localPlan = resolveWebSearchRoutingPlan({
			enabled: true,
			modelInfo: { capabilities: { tools: [ServerTool.WEB_SEARCH] } },
			selectedApiFormat: ApiFormat.OPENAI_CHAT,
			localAvailable: true,
			remoteAdapterAvailable: false,
		})

		await expect(
			requestHostedWebApproval(
				{ open },
				{
					taskId: "task-1",
					apiIndex: 5,
					providerId: "openai",
					routingPlan: localPlan,
					autoApproved: false,
				},
			),
		).resolves.toEqual({ required: false, approved: true })
		expect(localPlan.route).toBe("local")
		expect(open).not.toHaveBeenCalled()
	})
})
