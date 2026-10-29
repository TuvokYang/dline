/**
 * SAP AI Core `GET /v2/lm/deployments`.
 *
 * Unlike every other vendor here, listing takes two round trips: a client
 * credentials exchange against the XSUAA token URL, then the deployment query.
 * Both steps live in this subclass so the orchestration layer keeps a single
 * `fetchModels` contract.
 *
 * A "model" in this catalog is a running deployment: the model name identifies
 * the entry and the deployment id is the routing target the API handler needs.
 */
import type { ModelCapabilities, ModelInfo } from "@shared/providers/types"
import { fetch } from "@/shared/net"
import type { ProviderModelReconciliationMode } from "../../provider-model-reconciliation"
import { isRecord, ModelListingSource, readString } from "../model-listing-source"
import type { ProviderRemoteContext } from "../model-source"

/** Credential fields carried in `vendorCredentials` for this source. */
export const SAP_AI_CORE_CREDENTIAL_KEYS = {
    clientId: "clientId",
    clientSecret: "clientSecret",
    tokenUrl: "tokenUrl",
    resourceGroup: "resourceGroup",
} as const

/** Only deployments in this state can serve a request. */
const RUNNING_TARGET_STATUS = "RUNNING"

/** The scenario id SAP uses for its orchestration deployment. */
const ORCHESTRATION_SCENARIO_ID = "orchestration"

const DEPLOYMENT_PAGE_SIZE = 10_000

export interface SapAiCoreDeployment {
    readonly deploymentId: string
    /** Lowercased model name, matching what the settings dropdown selects. */
    readonly modelName: string
}

export interface SapAiCoreListing {
    readonly models: Record<string, ModelInfo>
    readonly deployments: readonly SapAiCoreDeployment[]
    readonly orchestrationAvailable: boolean
}

export class SapAiCoreModelSource extends ModelListingSource {
    readonly providerId = "sapaicore"
    readonly providerName = "SAP AI Core"
    /** Authentication is a client credential pair, not an API key. */
    override readonly requiresApiKey: boolean = false
    override readonly reconciliation: ProviderModelReconciliationMode = "replace"
    protected override readonly defaultBaseUrl = ""

    /** Deployment ids change per tenant, so the extras are produced alongside the catalog. */
    async fetchListing(context: ProviderRemoteContext): Promise<SapAiCoreListing> {
        if (!this.hasRequiredCredentials(context)) {
            return { models: {}, deployments: [], orchestrationAvailable: false }
        }

        const entries = await this.fetchAllPages(context)
        const running = entries.filter((entry) => readString(entry, "targetStatus") === RUNNING_TARGET_STATUS)

        const models: Record<string, ModelInfo> = {}
        const deployments: SapAiCoreDeployment[] = []
        for (const entry of running) {
            const modelId = this.readModelId(entry)
            const deploymentId = readString(entry, "id")
            if (!modelId || !deploymentId) {
                continue
            }
            models[modelId] = this.toModelInfo(entry, modelId)
            deployments.push({ deploymentId, modelName: modelId.split(":")[0].toLowerCase() })
        }

        deployments.sort((left, right) => left.modelName.localeCompare(right.modelName))

        return {
            models,
            deployments,
            orchestrationAvailable: running.some((entry) => readString(entry, "scenarioId") === ORCHESTRATION_SCENARIO_ID),
        }
    }

    override async fetchModels(context: ProviderRemoteContext): Promise<Record<string, ModelInfo>> {
        return (await this.fetchListing(context)).models
    }

    protected override buildListingUrl(context: ProviderRemoteContext): string {
        const base = (context.baseUrl ?? "").replace(/\/+$/, "")
        return `${base}/v2/lm/deployments?$top=${DEPLOYMENT_PAGE_SIZE}&$skip=0`
    }

    /** Exchanges the client credentials before every listing request. */
    protected override async buildHeaders(context: ProviderRemoteContext): Promise<Record<string, string>> {
        const accessToken = await this.requestAccessToken(context)
        return {
            Authorization: `Bearer ${accessToken}`,
            "AI-Resource-Group": this.readCredential(context, SAP_AI_CORE_CREDENTIAL_KEYS.resourceGroup) || "default",
            "Content-Type": "application/json",
            "AI-Client-Type": "Cline",
        }
    }

    protected override readPageEntries(payload: unknown): unknown[] {
        if (!isRecord(payload)) {
            return []
        }
        return Array.isArray(payload.resources) ? payload.resources : []
    }

    /** `<name>:<version>` identifies a deployed model; entries without both are unusable. */
    protected override readModelId(raw: unknown): string | undefined {
        const modelPath = "details.resources.backend_details.model"
        const name = readString(raw, `${modelPath}.name`)
        const version = readString(raw, `${modelPath}.version`)
        return name && version ? `${name}:${version}` : undefined
    }

    /** Running state was already filtered; the base id heuristics do not apply here. */
    protected override isChatModel(raw: unknown): boolean {
        return isRecord(raw)
    }

    /** The deployment record carries no context or token limits. */
    protected override readCapabilities(): ModelCapabilities {
        return {}
    }

    protected override readDescription(raw: unknown): string | undefined {
        return readString(raw, "scenarioId")
    }

    private async requestAccessToken(context: ProviderRemoteContext): Promise<string> {
        const tokenUrl = this.readCredential(context, SAP_AI_CORE_CREDENTIAL_KEYS.tokenUrl)
        const clientId = this.readCredential(context, SAP_AI_CORE_CREDENTIAL_KEYS.clientId)
        const clientSecret = this.readCredential(context, SAP_AI_CORE_CREDENTIAL_KEYS.clientSecret)
        if (!tokenUrl || !clientId || !clientSecret) {
            throw new Error("SAP AI Core credentials are incomplete")
        }

        const payload = await this.requestJsonWithoutAuth(`${tokenUrl.replace(/\/+$/, "")}/oauth/token`, context, {
            grant_type: "client_credentials",
            client_id: clientId,
            client_secret: clientSecret,
        })

        const accessToken = readString(payload, "access_token")
        if (!accessToken) {
            throw new Error("SAP AI Core token response did not contain an access token")
        }
        return accessToken
    }

    /**
     * The token exchange cannot reuse `requestJson`, which would recurse through
     * `buildHeaders` and request another token.
     */
    private async requestJsonWithoutAuth(
        url: string,
        context: ProviderRemoteContext,
        form: Record<string, string>,
    ): Promise<unknown> {
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams(form).toString(),
            signal: context.signal,
        })
        if (!response.ok) {
            throw new Error(`${this.providerName} token request failed with status ${response.status}`)
        }
        return response.json()
    }

    private hasRequiredCredentials(context: ProviderRemoteContext): boolean {
        return Boolean(
            context.baseUrl &&
                this.readCredential(context, SAP_AI_CORE_CREDENTIAL_KEYS.clientId) &&
                this.readCredential(context, SAP_AI_CORE_CREDENTIAL_KEYS.clientSecret),
        )
    }

    private readCredential(context: ProviderRemoteContext, key: string): string | undefined {
        return context.vendorCredentials?.[key] || undefined
    }
}

export const sapAiCoreModelSource = new SapAiCoreModelSource()
