import { hasHostedWebRoute, isHostedToolRouted, type WebSearchRoutingPlan } from "@core/api/server-tools"
import type { ClineSayTool } from "@shared/ExtensionMessage"
import { ServerTool } from "@shared/proto/dline/models/metadata"
import type { InteractionOutcome, OpenInteractionRequest } from "./InteractionCoordinator"

export interface HostedWebApprovalInput {
	readonly taskId: string
	readonly apiIndex: number
	readonly providerId: string
	readonly routingPlan: WebSearchRoutingPlan
	readonly autoApproved: boolean
}

export interface HostedWebApprovalDecision {
	readonly required: boolean
	readonly approved: boolean
}

export interface HostedWebApprovalPort {
	open(request: OpenInteractionRequest): Promise<InteractionOutcome>
}

function providerLabel(providerId: string): string {
	switch (providerId) {
		case "openai":
			return "OpenAI"
		case "deepseek":
			return "DeepSeek"
		case "anthropic":
			return "Anthropic"
		default:
			return providerId
	}
}

/** Build the stable identity for one logical Provider request approval. */
export function hostedWebApprovalId(taskId: string, apiIndex: number): string {
	return `hosted-web:${taskId}:${apiIndex}`
}

/** Parse the durable request index only from this task's exact Hosted approval identity. */
export function hostedWebApprovalApiIndex(taskId: string, interactionId: string): number | undefined {
	const prefix = `hosted-web:${taskId}:`
	if (!interactionId.startsWith(prefix)) return undefined
	const rawIndex = interactionId.slice(prefix.length)
	if (!/^(0|[1-9]\d*)$/.test(rawIndex)) return undefined
	const apiIndex = Number(rawIndex)
	return Number.isSafeInteger(apiIndex) ? apiIndex : undefined
}

/**
 * Name the provider-hosted web tools one request would run.
 *
 * Web Search and Web Fetch route independently, so the approval must name what the
 * request actually declares rather than assume search.
 */
export function hostedWebCapabilityLabel(routingPlan: WebSearchRoutingPlan): string {
	const names: string[] = []
	if (isHostedToolRouted(routingPlan, ServerTool.WEB_SEARCH)) names.push("Web Search")
	if (isHostedToolRouted(routingPlan, ServerTool.WEB_FETCH)) names.push("Web Fetch")
	return names.length === 0 ? "Web Search" : names.join(" and ")
}

/** Project a request-level hosted web approval into the existing Web Search card. */
export function hostedWebApprovalPresentation(providerId: string, routingPlan: WebSearchRoutingPlan): string {
	const label = providerLabel(providerId)
	const capability = `${label} provider-hosted ${hostedWebCapabilityLabel(routingPlan)}`
	return JSON.stringify({
		tool: "webSearch",
		path: `Allow ${capability} for this request`,
		content: `Allow ${capability} for this request`,
		operationIsLocatedInWorkspace: false,
		webSearch: {
			schemaVersion: 1,
			status: "running",
			source: {
				id: `${providerId}-hosted`,
				label: `${label} Web Search`,
				execution: "hosted",
				provider: providerId,
			},
			query: capability,
		},
	} satisfies ClineSayTool)
}

/** Wait for request-level approval without changing the already selected web tool routes. */
export async function requestHostedWebApproval(
	port: HostedWebApprovalPort,
	input: HostedWebApprovalInput,
): Promise<HostedWebApprovalDecision> {
	if (!hasHostedWebRoute(input.routingPlan) || input.autoApproved) {
		return { required: false, approved: true }
	}

	const interactionId = hostedWebApprovalId(input.taskId, input.apiIndex)
	const outcome = await port.open({
		turnId: interactionId,
		interactionId,
		kind: "hosted_web_approval",
		presentation: hostedWebApprovalPresentation(input.providerId, input.routingPlan),
	})
	return { required: true, approved: outcome.actionId === "approve" }
}
