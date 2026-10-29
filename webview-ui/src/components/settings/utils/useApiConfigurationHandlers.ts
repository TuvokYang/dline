import { ApiConfiguration } from "@shared/api"
import { UpdateApiConfigurationPartialRequest } from "@shared/proto/dline/models"
import { convertApiConfigurationToProto } from "@shared/proto-conversions/models/api-configuration-conversion"
import { ModelsServiceClient } from "@/services/grpc-client"

export const useApiConfigurationHandlers = () => {
    /**
     * Updates a single field in the API configuration.
     *
     * Only the named field is sent, so changes made in quick succession, or by
     * another window, are not overwritten with the configuration this view last saw.
     *
     * @param field - The field key to update
     * @param value - The new value for the field
     */
    const handleFieldChange = async <K extends keyof ApiConfiguration>(field: K, value: ApiConfiguration[K]) => {
        await ModelsServiceClient.updateApiConfigurationPartial(
            UpdateApiConfigurationPartialRequest.create({
                apiConfiguration: convertApiConfigurationToProto({ [field]: value } as ApiConfiguration),
                updateMask: [field],
            }),
        )
    }

    return { handleFieldChange }
}
