import type { ModelInfo } from "@shared/proto/dline/models"
import { ProviderModelsRequest } from "@shared/proto/dline/models"
import { useCallback, useMemo } from "react"
import { ModelsServiceClient } from "@/services/grpc-client"
import { useModelProbe } from "./useModelProbe"
import { type ProviderModelsResult, useProviderModels } from "./useProviderModels"

/**
 * Where a picker entry came from.
 *
 * `catalog` entries carry pricing and capabilities the local registry ships.
 * `remote` entries exist only in the vendor's listing, so the picker marks
 * them as newly discovered without inventing capabilities or prices.
 */
export type ModelOptionOrigin = "catalog" | "remote"

export interface ProviderModelOptions extends ProviderModelsResult {
	/**
	 * Local catalog entries merged with the ids the provider currently lists.
	 * Catalog metadata wins, so remote discovery only adds models the local
	 * registry does not know about yet.
	 */
	options: Record<string, ModelInfo>
	/**
	 * Origin per option id. The picker reads this to badge models the local
	 * catalog does not know about; ids missing from the map are free-form
	 * entries the user typed.
	 */
	optionOrigins: Record<string, ModelOptionOrigin>
	/** Triggers a listing request; safe to bind to a picker's `onOpen`. */
	refreshRemoteModels: () => void
}

export interface ProviderModelOptionsInput {
	providerId: string
	/**
	 * Reads the profile's stored secret when the form has no API key of its
	 * own, which is the normal case because keys live in secrets rather than
	 * on the profile. Without it the listing falls back to whichever profile
	 * of the provider happens to hold a key.
	 */
	profileId?: string
	/** Unsaved base URL from the settings form; empty falls back to saved credentials. */
	baseUrl?: string
	/** Unsaved API key from the settings form; empty falls back to saved credentials. */
	apiKey?: string
	/** Kept in the list so the current selection stays visible before a listing returns. */
	selectedModelId?: string
}

/**
 * The model picker's data source.
 *
 * A provider's models come from two places: the local catalog, which carries
 * pricing and capabilities, and the vendor's listing endpoint, which knows
 * about models released after the catalog was written. Both belong in the same
 * dropdown, so the merge lives here instead of in each provider component.
 */
export function useProviderModelOptions({
	providerId,
	profileId,
	baseUrl,
	apiKey,
	selectedModelId,
}: ProviderModelOptionsInput): ProviderModelOptions {
	const catalog = useProviderModels(providerId)

	const probe = useCallback(async () => {
		const response = await ModelsServiceClient.refreshProviderModels(
			ProviderModelsRequest.create({ providerId, profileId, baseUrl, apiKey }),
		)
		return response.values
	}, [apiKey, baseUrl, profileId, providerId])

	// Listing-only entries carry identity; catalog declarations are merged separately.
	const { models: discovered, refresh: refreshRemoteModels } = useModelProbe({
		probe,
		credentialsKey: `${providerId}|${profileId ?? ""}|${baseUrl ?? ""}|${apiKey ?? ""}`,
		enabled: true,
	})

	const options = useMemo<Record<string, ModelInfo>>(() => {
		const merged: Record<string, ModelInfo> = { ...discovered, ...catalog.models }
		if (selectedModelId && !merged[selectedModelId]) {
			merged[selectedModelId] = { id: selectedModelId, name: selectedModelId }
		}
		return merged
	}, [catalog.models, discovered, selectedModelId])

	// The merged record loses each id's source because catalog metadata
	// overwrites the synthesized entry, so the origin is derived from the
	// catalog membership rather than from a flag on the merged value.
	const optionOrigins = useMemo<Record<string, ModelOptionOrigin>>(() => {
		const origins: Record<string, ModelOptionOrigin> = {}
		for (const id of Object.keys(discovered)) {
			origins[id] = "remote"
		}
		for (const id of Object.keys(catalog.models)) {
			origins[id] = "catalog"
		}
		return origins
	}, [catalog.models, discovered])

	return { ...catalog, options, optionOrigins, refreshRemoteModels }
}
