import type { EmptyRequest } from "@shared/proto/dline/common"
import type { InputSemanticCatalog } from "@shared/proto/dline/slash"
import { toProtoInputSemanticCatalog } from "@shared/proto-conversions/input-semantics/catalog"
import type { Controller } from "../index"
import { publishInputSemanticCatalog } from "./subscribeToInputSemanticCatalog"

/**
 * Return the input semantic catalog for this controller.
 *
 * The read rediscovers capabilities so a composer that just opened sees the
 * current set, and any subscriber learns about the same revision.
 */
export async function getInputSemanticCatalog(controller: Controller, _request: EmptyRequest): Promise<InputSemanticCatalog> {
    return toProtoInputSemanticCatalog(await publishInputSemanticCatalog(controller))
}
