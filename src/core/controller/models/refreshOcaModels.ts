import { StringRequest } from "@shared/proto/dline/common"
import { OcaCompatibleModelInfo, OcaModelInfo as ProtoOcaModelInfo } from "@shared/proto/dline/models"
import { ApiFormat } from "@shared/proto/dline/models/metadata"
import { persistProviderCatalog } from "@/core/model-registry/provider-catalog-storage"
import { ocaModelSource } from "@/core/model-registry/remote/vendors/oca"
import { HostProvider } from "@/hosts/host-provider"
import { OcaAuthService } from "@/services/auth/oca/OcaAuthService"
import { DEFAULT_EXTERNAL_OCA_BASE_URL, DEFAULT_INTERNAL_OCA_BASE_URL } from "@/services/auth/oca/utils/constants"
import { createOcaHeaders } from "@/services/auth/oca/utils/utils"
import { ShowMessageType } from "@/shared/proto/dline/host"
import { Logger } from "@/shared/services/Logger"
import { Controller } from ".."

/**
 * Refreshes the Oca models and returns the updated model list
 * @param controller The controller instance
 * @param request Empty request object
 * @returns Response containing the Oca models
 */
export async function refreshOcaModels(controller: Controller, request: StringRequest): Promise<OcaCompatibleModelInfo> {
	const models: Record<string, ProtoOcaModelInfo> = {}
	const ocaAccessToken = await OcaAuthService.getInstance().getAuthToken()
	if (!ocaAccessToken) {
		HostProvider.window.showMessage({
			type: ShowMessageType.ERROR,
			message: "Not authenticated with OCA. Please sign in first.",
		})
		return OcaCompatibleModelInfo.create({ error: "Not authenticated with OCA" })
	}
	const ocaMode = controller.stateManager.getGlobalSettingsKey("ocaMode") || "internal"
	const baseUrl = request.value || (ocaMode === "internal" ? DEFAULT_INTERNAL_OCA_BASE_URL : DEFAULT_EXTERNAL_OCA_BASE_URL)
	const headers = await createOcaHeaders(ocaAccessToken!, "models-refresh")
	try {
		Logger.log(`Making refresh oca model request with customer opc-request-id: ${headers["opc-request-id"]}`)
		const listing = await ocaModelSource.fetchModelsWithExtras({ baseUrl, apiKey: ocaAccessToken })
		if (Object.keys(listing.models).length === 0) {
			Logger.error("Invalid response from OCA API")
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message: "No models found. Did you set up your OCA access (possibly through entitlements)?",
			})
			return OcaCompatibleModelInfo.create({ models })
		}

		await persistProviderCatalog({
			providerId: ocaModelSource.providerId,
			providerName: ocaModelSource.providerName,
			baseUrl,
			billingMode: ocaModelSource.billingMode,
			models: listing.models,
			reconciliationMode: ocaModelSource.reconciliation,
		})

		for (const [modelId, catalogModel] of Object.entries(listing.models)) {
			// Banner, survey and reasoning-effort options are OCA-specific and
			// have no place in the shared catalog, so they travel separately to
			// the OCA settings UI.
			const extras = listing.extras[modelId]

			models[modelId] = ProtoOcaModelInfo.create({
				maxTokens: catalogModel.capabilities?.maxTokens ?? -1,
				contextWindow: catalogModel.capabilities?.contextWindow,
				supportsImages: catalogModel.capabilities?.supportsImages ?? false,
				supportsPromptCache: catalogModel.capabilities?.supportsPromptCache ?? false,
				inputPrice: catalogModel.pricing?.inputPrice ?? 0,
				outputPrice: catalogModel.pricing?.outputPrice ?? 0,
				cacheWritesPrice: catalogModel.pricing?.cacheWritesPrice ?? 0,
				cacheReadsPrice: catalogModel.pricing?.cacheReadsPrice ?? 0,
				description: catalogModel.description,
				thinkingConfig: catalogModel.capabilities?.thinking,
				temperature: catalogModel.temperature ?? 0,
				modelName: modelId,
				apiFormat: catalogModel.apiFormats?.[0] ?? ApiFormat.OPENAI_CHAT,
				supportsReasoning: catalogModel.capabilities?.supportsReasoning ?? false,
				banner: extras?.banner,
				surveyId: extras?.surveyId,
				surveyContent: extras?.surveyContent,
				reasoningEffortOptions: extras?.reasoningEffortOptions ?? [],
			})
		}
		Logger.log("OCA models fetched", models)

		HostProvider.window.showMessage({
			type: ShowMessageType.INFORMATION,
			message: `Refreshed OCA models from ${baseUrl}`,
		})
		await controller.postStateToWebview?.()
	} catch (err: unknown) {
		const userMsg = describeOcaFailure(err)
		Logger.error(userMsg, err)
		HostProvider.window.showMessage({
			type: ShowMessageType.ERROR,
			message: `Error refreshing OCA models. ${userMsg} opc-request-id: ${headers["opc-request-id"]}`,
		})
		return OcaCompatibleModelInfo.create({ error: userMsg })
	}
	return OcaCompatibleModelInfo.create({ models })
}

/**
 * The listing rejects with an HTTP status message for a refused request and
 * with a transport error when the backend cannot be reached at all; the two
 * need different remedies, so they get different guidance.
 */
function describeOcaFailure(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err)
	if (/\b(4\d{2}|5\d{2})\b/.test(message)) {
		return `Did you set up your OCA access (possibly through entitlements)? OCA service returned: ${message}`
	}
	if (err instanceof TypeError || /timed out|aborted|ECONN|ENOTFOUND|fetch failed/i.test(message)) {
		return "Unable to access the OCA backend. Is your endpoint and proxy configured properly? Please see the troubleshooting guide."
	}
	return message
}
