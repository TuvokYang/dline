import { findEnabledProfiles, PROVIDER_API_KEY_MAP } from "@core/controller/file/getApiProfiles"
import * as SecretsManager from "@core/storage/secrets"
import { Empty } from "@shared/proto/dline/common"
import { UpdateApiConfigurationRequestNew } from "@/shared/proto/dline"
import { Logger } from "@/shared/services/Logger"
import { GlobalStateAndSettings, Secrets } from "@/shared/storage/state-keys"
import type { Controller } from "../index"

/**
 * Parses field mask paths into separate sets for options and secrets
 * @param updateMask Array of field mask paths (e.g., ["options.ulid", "options.openAiHeaders", "secrets.apiKey"])
 * @returns Object with options and secrets field name sets
 */
function parseFieldMask(updateMask: string[]): {
	options: Set<string>
	secrets: Set<string>
} {
	const options = new Set<string>()
	const secrets = new Set<string>()

	for (const path of updateMask) {
		const [prefix, fieldName] = path.split(".", 2)
		if (prefix === "options" && fieldName) {
			options.add(fieldName)
		} else if (prefix === "secrets" && fieldName) {
			secrets.add(fieldName)
		} else {
			throw new Error(`Invalid field mask path: ${path}`)
		}
	}

	return { options, secrets }
}

/**
 * Gets the alternate mode field name (e.g., planModeX <-> actModeX)
 * @param fieldName The field name to get alternate for
 * @returns The alternate mode field name or null if not a mode-specific field
 */
function getAlternateModeField(fieldName: string): string | null {
	if (fieldName.startsWith("planMode")) {
		return fieldName.replace("planMode", "actMode")
	}
	if (fieldName.startsWith("actMode")) {
		return fieldName.replace("actMode", "planMode")
	}
	return null
}

/**
 * Updates API configuration using field mask
 * @param controller The controller instance
 * @param request The update API configuration request with field mask
 * @returns Empty response
 */
export async function updateApiConfiguration(controller: Controller, request: UpdateApiConfigurationRequestNew): Promise<Empty> {
	try {
		const { updates, updateMask } = request

		if (!updates) {
			throw new Error("API configuration is required")
		}

		if (!updateMask || updateMask.length === 0) {
			throw new Error("Update mask is required and must contain at least one path")
		}

		const { options: protoOptions, secrets: protoSecrets } = updates

		// Parse the field mask to determine which fields to update
		const { options: maskOptionsFields, secrets: maskSecretsFields } = parseFieldMask(updateMask)

		// Process secrets based on field mask
		const secrets: Partial<Secrets> = {}

		if (protoSecrets && maskSecretsFields.size > 0) {
			// Validate all masked fields exist
			for (const fieldName of maskSecretsFields) {
				if (!(fieldName in protoSecrets)) {
					throw new Error(`Field "${fieldName}" specified in mask but not found in secrets`)
				}
			}
			// Process entries that are in the mask
			for (const [key, value] of Object.entries(protoSecrets)) {
				if (maskSecretsFields.has(key)) {
					secrets[key as keyof Secrets] = value
				}
			}
		}

		// Process options based on field mask
		const options: Partial<GlobalStateAndSettings> = {}
		// Masked option names are validated against the request above, not against the settings type.
		const assignOption = (key: string, value: unknown) => {
			;(options as Record<string, unknown>)[key] = value
		}
		if (protoOptions && maskOptionsFields.size > 0) {
			// Validate all masked fields exist
			for (const fieldName of maskOptionsFields) {
				if (!(fieldName in protoOptions)) {
					throw new Error(`Field "${fieldName}" specified in mask but not found in options`)
				}
			}

			// Check if mode-specific configurations should be kept separate
			const separateModeConfigs = controller.stateManager.getGlobalSettingsKey("planActSeparateModelsSetting")

			// Process entries that are in the mask
			for (const [key, value] of Object.entries(protoOptions)) {
				if (maskOptionsFields.has(key)) {
					// Handle enum conversions
					if (key === "planModeProfile") {
						if (typeof value === "string") options.planModeProfile = value
					} else if (key === "actModeProfile") {
						if (typeof value === "string") options.actModeProfile = value
					} else {
						assignOption(key, value)
					}

					// If mode configs should be synced, also update the alternate mode field
					if (!separateModeConfigs) {
						const alternateField = getAlternateModeField(key)
						if (alternateField) {
							if (alternateField === "planModeProfile") {
								if (typeof value === "string") options.planModeProfile = value
							} else if (alternateField === "actModeProfile") {
								if (typeof value === "string") options.actModeProfile = value
							} else {
								assignOption(alternateField, value)
							}
						}
					}
				}
			}
		}

		// Update storage using batch methods
		if (Object.keys(secrets).length > 0) {
			controller.stateManager.setSecretsBatch(secrets)

			// Bridge: sync apiKey fields to data/secrets/api_keys.json
			// Build reverse mapping: apiKeyField → provider
			const apiKeyToProvider: Record<string, string> = {}
			for (const [provider, field] of Object.entries(PROVIDER_API_KEY_MAP)) {
				apiKeyToProvider[field] = provider
			}
			for (const [key, value] of Object.entries(secrets)) {
				const provider = apiKeyToProvider[key]
				if (provider && typeof value === "string" && value) {
					const profiles = findEnabledProfiles(provider)
					if (profiles.length > 0) {
						for (const p of profiles) {
							SecretsManager.setApiKey(p.id, value, p.name)
						}
					}
				}
			}
		}
		if (Object.keys(options).length > 0) {
			controller.stateManager.setGlobalStateBatch(options)
		}

		// Update the task's API handler if there's an active task
		if (controller.task) {
			// Refresh the active handler and canonical Profile validity after explicit configuration updates.
			await controller.task.owners.api.rebuild({ abortPrevious: true })
		}
		controller.restartAccountUsagePolling()

		// Post updated state to webview
		await controller.postStateToWebview()

		return Empty.create()
	} catch (error) {
		Logger.error(`Failed to update API configuration: ${error}`)
		throw error
	}
}
