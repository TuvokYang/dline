import {
    type AccountUsageResetCreditRequest,
    AccountUsageResetResult as ProtoAccountUsageResetResult,
} from "@shared/proto/dline/account"
import { accountUsageToProto } from "@shared/proto-conversions/account-usage-conversion"
import type { Controller } from ".."

/** Consume one reset credit through the selected provider's shared usage capability. */
export async function consumeAccountUsageResetCredit(
    controller: Controller,
    request: AccountUsageResetCreditRequest,
): Promise<ProtoAccountUsageResetResult> {
    const creditId = request.creditId.trim()
    if (creditId.length === 0) throw new Error("An account usage reset-credit ID is required.")
    const { result, usage } = await controller.consumeProviderUsageResetCredit(request.profileId, creditId)
    return ProtoAccountUsageResetResult.create({
        profileId: usage.profileId,
        outcome: result.outcome,
        quotaTypesReset: [...result.quotaTypesReset],
        usage: accountUsageToProto(usage),
    })
}
