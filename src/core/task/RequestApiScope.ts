import { randomUUID } from "node:crypto"
import type { ApiHandler, ApiProviderInfo } from "@core/api"
import {
	type HostedImageGenerationPlan,
	resolveHostedImageGenerationPlan,
	resolveWebSearchRoutingPlan,
	type WebSearchRoutingPlan,
} from "@core/api/server-tools"
import { PromptProfile } from "@core/prompts/profiles/types"
import { ExplicitInstructionRegistry } from "@core/task/explicit-instructions/ExplicitInstructionRegistry"
import { ExplicitInstructionRequestScope } from "@core/task/explicit-instructions/ExplicitInstructionRequestScope"
import { type ApiFormat, ServerTool } from "@shared/proto/dline/models/metadata"
import { resolvePromptProfile } from "@shared/resolve-prompt-profile"

export interface RequestApiScope {
	readonly api: ApiHandler
	readonly providerInfo: Readonly<ApiProviderInfo>
	readonly selectedApiFormat: ApiFormat | undefined
	readonly webToolsEnabled: boolean
	readonly webSearchRoutingPlan: WebSearchRoutingPlan
	readonly hostedImageGenerationPlan: HostedImageGenerationPlan
	readonly explicitInstructions: ExplicitInstructionRequestScope
}

type RequestModel = ReturnType<ApiHandler["getModel"]>

function resolveSelectedApiFormat(api: ApiHandler, model: RequestModel): ApiFormat | undefined {
	// The handler knows the protocol the request will actually use. A model's
	// declared formats are only a fallback, and a free-form model id declares none.
	return api.getSelectedApiFormat?.() ?? model.info.apiFormats?.[0]
}

function buildRequestWebSearchRoutingPlan(
	api: ApiHandler,
	model: RequestModel,
	enabled: boolean,
	selectedApiFormat: ApiFormat | undefined,
): WebSearchRoutingPlan {
	const promptProfile = resolvePromptProfile({
		modelId: model.id,
		contextWindow: model.info.capabilities?.contextWindow,
	})
	return resolveWebSearchRoutingPlan({
		enabled,
		mode: api.getWebToolsMode?.(),
		modelInfo: model.info,
		disabledServerTools: api.getDisabledServerTools?.(),
		selectedApiFormat,
		localAvailable: promptProfile === PromptProfile.Standard,
		remoteAdapterAvailable: api.supportsServerTool?.(ServerTool.WEB_SEARCH) === true,
		remoteWebFetchAdapterAvailable: api.supportsServerTool?.(ServerTool.WEB_FETCH) === true,
	})
}

/** Resolve Web Search once from the handler/profile captured for a request. */
export function resolveRequestWebSearchRoutingPlan(api: ApiHandler, enabled: boolean): WebSearchRoutingPlan {
	const model = api.getModel()
	return buildRequestWebSearchRoutingPlan(api, model, enabled, resolveSelectedApiFormat(api, model))
}

function buildRequestHostedImageGenerationPlan(
	api: ApiHandler,
	model: RequestModel,
	enabled: boolean,
	selectedApiFormat: ApiFormat | undefined,
): HostedImageGenerationPlan {
	return resolveHostedImageGenerationPlan({
		enabled,
		source: api.getImageGenerationSource?.(),
		modelInfo: model.info,
		selectedApiFormat,
		remoteAdapterAvailable: api.supportsServerTool?.(ServerTool.IMAGE_GENERATION) === true,
	})
}

/** Resolve Hosted image generation once from the handler/profile captured for a request. */
export function resolveRequestHostedImageGenerationPlan(api: ApiHandler, enabled: boolean): HostedImageGenerationPlan {
	const model = api.getModel()
	return buildRequestHostedImageGenerationPlan(api, model, enabled, resolveSelectedApiFormat(api, model))
}

/** Capture one immutable handler/model/provider view for an API request. */
export function createRequestApiScope(
	api: ApiHandler,
	mode: ApiProviderInfo["mode"],
	customPrompt?: string,
	webToolsEnabled = false,
	explicitInstructionRegistry = new ExplicitInstructionRegistry(),
	imageGenerationEnabled = false,
): RequestApiScope {
	const providerId = api.getProviderId?.()
	if (!providerId) {
		throw new Error("API handler is missing its provider identity")
	}
	const model = api.getModel()
	const selectedApiFormat = resolveSelectedApiFormat(api, model)
	const frozenWebToolsEnabled = webToolsEnabled === true

	return Object.freeze({
		api,
		explicitInstructions: new ExplicitInstructionRequestScope(explicitInstructionRegistry, {
			requestId: randomUUID(),
			attemptId: randomUUID(),
		}),
		webToolsEnabled: frozenWebToolsEnabled,
		selectedApiFormat,
		webSearchRoutingPlan: buildRequestWebSearchRoutingPlan(api, model, frozenWebToolsEnabled, selectedApiFormat),
		hostedImageGenerationPlan: buildRequestHostedImageGenerationPlan(
			api,
			model,
			imageGenerationEnabled === true,
			selectedApiFormat,
		),
		providerInfo: Object.freeze({
			providerId,
			model,
			mode,
			...(customPrompt === undefined ? {} : { customPrompt }),
		}),
	})
}
