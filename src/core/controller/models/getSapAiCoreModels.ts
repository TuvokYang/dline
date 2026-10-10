import { persistProviderCatalog } from "@/core/model-registry/provider-catalog-storage"
import { SAP_AI_CORE_CREDENTIAL_KEYS, sapAiCoreModelSource } from "@/core/model-registry/remote/vendors/sapaicore"
import { SapAiCoreModelDeployment, SapAiCoreModelsRequest, SapAiCoreModelsResponse } from "@/shared/proto/dline/models"
import { Logger } from "@/shared/services/Logger"
import { Controller } from ".."

const EMPTY_RESPONSE = { deployments: [], orchestrationAvailable: false }

/**
 * Fetches available models from SAP AI Core deployments and orchestration
 * availability, persisting the discovered catalog like every other provider.
 * @param controller The controller instance
 * @param request The request containing SAP AI Core configuration
 * @returns SapAiCoreModelsResponse with deployments and orchestration availability
 */
export async function getSapAiCoreModels(
    _controller: Controller,
    request: SapAiCoreModelsRequest,
): Promise<SapAiCoreModelsResponse> {
    if (!request.clientId || !request.clientSecret || !request.baseUrl) {
        return SapAiCoreModelsResponse.create(EMPTY_RESPONSE)
    }

    try {
        const listing = await sapAiCoreModelSource.fetchListing({
            baseUrl: request.baseUrl,
            vendorCredentials: {
                [SAP_AI_CORE_CREDENTIAL_KEYS.clientId]: request.clientId,
                [SAP_AI_CORE_CREDENTIAL_KEYS.clientSecret]: request.clientSecret,
                [SAP_AI_CORE_CREDENTIAL_KEYS.tokenUrl]: request.tokenUrl,
                [SAP_AI_CORE_CREDENTIAL_KEYS.resourceGroup]: request.resourceGroup,
            },
        })

        if (Object.keys(listing.models).length > 0) {
            await persistProviderCatalog({
                providerId: sapAiCoreModelSource.providerId,
                providerName: sapAiCoreModelSource.providerName,
                baseUrl: request.baseUrl,
                billingMode: sapAiCoreModelSource.billingMode,
                models: listing.models,
                reconciliationMode: sapAiCoreModelSource.reconciliation,
            })
        }

        return SapAiCoreModelsResponse.create({
            deployments: listing.deployments.map((deployment) =>
                SapAiCoreModelDeployment.create({
                    modelName: deployment.modelName,
                    deploymentId: deployment.deploymentId,
                }),
            ),
            orchestrationAvailable: listing.orchestrationAvailable,
        })
    } catch (error) {
        Logger.error("Error fetching SAP AI Core models:", error)
        return SapAiCoreModelsResponse.create(EMPTY_RESPONSE)
    }
}
