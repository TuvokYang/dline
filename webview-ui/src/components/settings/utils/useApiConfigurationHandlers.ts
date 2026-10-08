import { ApiConfiguration } from "@shared/api"
import { UpdateApiConfigurationRequest } from "@shared/proto/dline/models"
import { convertApiConfigurationToProto } from "@shared/proto-conversions/models/api-configuration-conversion"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { ModelsServiceClient } from "@/services/grpc-client"

export const useApiConfigurationHandlers = () => {
	const { apiConfiguration } = useExtensionState()

	/**
	 * Updates a single field in the API configuration.
	 *
	 * **Warning**: each call sends the whole configuration it was rendered with, so
	 * calls in rapid succession can overwrite one another's changes.
	 *
	 * @param field - The field key to update
	 * @param value - The new value for the field
	 */
	const handleFieldChange = async <K extends keyof ApiConfiguration>(field: K, value: ApiConfiguration[K]) => {
		const updatedConfig = {
			...apiConfiguration,
			[field]: value,
		}

		const protoConfig = convertApiConfigurationToProto(updatedConfig)
		await ModelsServiceClient.updateApiConfigurationProto(
			UpdateApiConfigurationRequest.create({
				apiConfiguration: protoConfig,
			}),
		)
	}

	return { handleFieldChange }
}
