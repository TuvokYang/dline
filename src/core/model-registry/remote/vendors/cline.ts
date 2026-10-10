/**
 * Cline `GET /api/v1/ai/cline/models`.
 *
 * The Cline API republishes an OpenRouter-shaped catalog, so the parsing is
 * inherited wholesale; only the endpoint differs. As with OpenRouter, the
 * vendor price corrections stay in the handler's post-process step.
 */
import { ClineEnv } from "@/config"
import type { ProviderRemoteContext } from "../model-source"
import { OpenRouterModelSource } from "./openrouter"

export class ClineModelSource extends OpenRouterModelSource {
    override readonly providerId = "cline"
    override readonly providerName = "Cline"
    protected override readonly defaultBaseUrl = ""

    /** The catalog hangs off the configured Cline API host, not a `/v1` root. */
    protected override buildListingUrl(context: ProviderRemoteContext): string {
        const apiBaseUrl = context.baseUrl || ClineEnv.config()?.apiBaseUrl || ""
        return `${apiBaseUrl}/api/v1/ai/cline/models`
    }
}

export const clineModelSource = new ClineModelSource()
