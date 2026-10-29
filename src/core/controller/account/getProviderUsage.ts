import { type ProviderUsageRequest } from "@shared/proto/dline/account"
import { AccountUsage as ProtoAccountUsage } from "@shared/proto/dline/state"
import { accountUsageToProto } from "@shared/proto-conversions/account-usage-conversion"
import type { Controller } from ".."

/** Returns the shared usage capability for one explicit Profile. */
export async function getProviderUsage(controller: Controller, request: ProviderUsageRequest): Promise<ProtoAccountUsage> {
    return accountUsageToProto(await controller.loadProviderUsageSnapshot(request.profileId)) ?? ProtoAccountUsage.create()
}
