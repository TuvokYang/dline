import { Empty } from "@shared/proto/dline/common"
import { TelemetrySettingRequest } from "@shared/proto/dline/state"
import { convertProtoTelemetrySettingToDomain } from "../../../shared/proto-conversions/state/telemetry-setting-conversion"
import { Controller } from ".."

/**
 * Records both reporting consents.
 *
 * The two travel together because the consent dialog presents them together,
 * but they are stored and gated independently.
 */
export async function updateTelemetrySetting(controller: Controller, request: TelemetrySettingRequest): Promise<Empty> {
    await controller.updateUsageReportingSetting(convertProtoTelemetrySettingToDomain(request.usageSetting))
    await controller.updateErrorReportingSetting(convertProtoTelemetrySettingToDomain(request.errorSetting))
    return Empty.create()
}
