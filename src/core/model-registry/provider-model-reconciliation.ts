import { mergeCapabilities } from "@shared/providers/effective-model-info"
import type { ImageModelInfo, ModelInfo, ProviderModelsConfig } from "@shared/providers/types"

export type ProviderModelReconciliationMode = "fill-missing" | "refresh-built-ins" | "overlay-remote" | "replace"

function mergeBuiltInModelDefaults(seed: ModelInfo, stored: ModelInfo): ModelInfo {
	return {
		...seed,
		...stored,
		capabilities:
			seed.capabilities || stored.capabilities
				? mergeCapabilities(seed.capabilities, stored.capabilities ?? {})
				: undefined,
		pricing: seed.pricing || stored.pricing ? { ...seed.pricing, ...stored.pricing } : undefined,
		apiFormats: stored.apiFormats ?? seed.apiFormats,
	}
}

function mergeBuiltInImageModelDefaults(seed: ImageModelInfo, stored: ImageModelInfo): ImageModelInfo {
	return {
		...seed,
		...stored,
		capabilities: seed.capabilities || stored.capabilities ? { ...seed.capabilities, ...stored.capabilities } : undefined,
		pricing: seed.pricing || stored.pricing ? { ...seed.pricing, ...stored.pricing } : undefined,
	}
}

function reconcileImageModels(
	seed: ProviderModelsConfig,
	stored: ProviderModelsConfig,
	mode: ProviderModelReconciliationMode,
): Record<string, ImageModelInfo> | undefined {
	const seedModels = seed.imageModels ?? {}
	const storedModels = stored.imageModels ?? {}
	if (mode === "fill-missing") {
		return Object.fromEntries(
			Object.entries(storedModels).map(([modelId, storedModel]) => {
				const seedModel = seedModels[modelId]
				if (!seedModel || storedModel.userDefined === true) return [modelId, storedModel]
				return [modelId, mergeBuiltInImageModelDefaults(seedModel, storedModel)]
			}),
		)
	}

	const models: Record<string, ImageModelInfo> = {}
	for (const [modelId, seedModel] of Object.entries(seedModels)) {
		const storedModel = storedModels[modelId]
		models[modelId] = storedModel?.userDefined === true ? storedModel : { ...seedModel, userDefined: false }
	}
	for (const [modelId, storedModel] of Object.entries(storedModels)) {
		if (seedModels[modelId] === undefined) models[modelId] = { ...storedModel, userDefined: true }
	}
	return Object.keys(models).length > 0 ? models : undefined
}

/** Drop keys whose value is undefined so that a spread never erases an existing field. */
function withoutUndefined<T extends object>(source: T): Partial<T> {
	return Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined)) as Partial<T>
}

/**
 * Overlay one remote listing entry on top of the stored model.
 *
 * Vendor listings are a supplement to the local catalog rather than a
 * replacement: fields the vendor does not report keep their stored values. This
 * matters most for pricing, which several listing endpoints omit entirely.
 */
function overlayRemoteModel(remote: ModelInfo, stored: ModelInfo): ModelInfo {
	return {
		...stored,
		...withoutUndefined(remote),
		capabilities:
			remote.capabilities || stored.capabilities
				? mergeCapabilities(stored.capabilities, remote.capabilities ?? {})
				: undefined,
		pricing: remote.pricing ? { ...stored.pricing, ...withoutUndefined(remote.pricing) } : stored.pricing,
		apiFormats: remote.apiFormats ?? stored.apiFormats,
		userDefined: stored.userDefined === true ? true : false,
	}
}

/**
 * Merge a remote catalog into the stored one.
 *
 * Models the vendor no longer lists are kept, because a listing outage must not
 * erase a working local configuration. Explicit user models are never touched.
 */
function overlayRemoteModels(remote: ProviderModelsConfig, stored: ProviderModelsConfig): Record<string, ModelInfo> {
	const models: Record<string, ModelInfo> = {}

	for (const [modelId, storedModel] of Object.entries(stored.models)) {
		models[modelId] = storedModel
	}

	for (const [modelId, remoteModel] of Object.entries(remote.models)) {
		const storedModel = stored.models[modelId]
		if (storedModel?.userDefined === true) {
			continue
		}
		models[modelId] = storedModel ? overlayRemoteModel(remoteModel, storedModel) : { ...remoteModel, userDefined: false }
	}

	return models
}

/**
 * Reconcile a persisted provider catalog with the current built-in metadata.
 * Explicit and legacy-unmarked user models are preserved; known built-ins are
 * refreshed, and retired models explicitly marked as built-in are removed.
 */
export function reconcileProviderModels(
	seed: ProviderModelsConfig,
	stored: ProviderModelsConfig,
	mode: ProviderModelReconciliationMode,
): ProviderModelsConfig {
	if (mode === "replace") {
		return seed
	}

	if (mode === "overlay-remote") {
		return {
			...stored,
			...seed,
			models: overlayRemoteModels(seed, stored),
			imageModels: reconcileImageModels(seed, stored, "fill-missing"),
			defaultImageModelId: stored.defaultImageModelId ?? seed.defaultImageModelId,
		}
	}

	if (mode === "fill-missing") {
		return {
			...stored,
			imageModels: reconcileImageModels(seed, stored, mode),
			defaultImageModelId: stored.defaultImageModelId ?? seed.defaultImageModelId,
			models: Object.fromEntries(
				Object.entries(stored.models).map(([modelId, storedModel]) => {
					const seedModel = seed.models[modelId]
					if (!seedModel || storedModel.userDefined === true) {
						return [modelId, storedModel]
					}
					return [modelId, mergeBuiltInModelDefaults(seedModel, storedModel)]
				}),
			),
		}
	}

	const models: Record<string, ModelInfo> = {}

	for (const [modelId, seedModel] of Object.entries(seed.models)) {
		const storedModel = stored.models[modelId]
		if (storedModel?.userDefined === true) {
			models[modelId] = storedModel
			continue
		}

		models[modelId] = { ...seedModel, userDefined: false }
	}

	for (const [modelId, storedModel] of Object.entries(stored.models)) {
		if (seed.models[modelId] !== undefined || storedModel.userDefined === false) {
			continue
		}
		models[modelId] = { ...storedModel, userDefined: true }
	}

	return {
		...seed,
		...stored,
		models,
		imageModels: reconcileImageModels(seed, stored, mode),
		defaultImageModelId: stored.defaultImageModelId ?? seed.defaultImageModelId,
	}
}

/** Add the built-in marker to every model in a newly generated seed file. */
export function markBuiltInModels(config: ProviderModelsConfig): ProviderModelsConfig {
	return {
		...config,
		models: Object.fromEntries(
			Object.entries(config.models).map(([modelId, model]) => [modelId, { ...model, userDefined: false }]),
		),
		imageModels: config.imageModels
			? Object.fromEntries(
					Object.entries(config.imageModels).map(([modelId, model]) => [modelId, { ...model, userDefined: false }]),
				)
			: undefined,
	}
}
