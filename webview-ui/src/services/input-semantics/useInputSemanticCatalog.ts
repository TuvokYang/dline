import type { InputSemanticCatalog } from "@shared/input-semantics/catalog"
import { EmptyRequest } from "@shared/proto/dline/common"
import { fromProtoInputSemanticCatalog } from "@shared/proto-conversions/input-semantics/catalog"
import { useEffect, useState } from "react"
import { SlashServiceClient } from "@/services/grpc-client"
import { acceptCatalogRevision, INITIAL_INPUT_SEMANTIC_CATALOG } from "./catalog-revision"

/**
 * Observe the input semantic catalog owned by this controller.
 *
 * The backend sends the current catalog on subscribe and then only on a real
 * revision change, so the composer holds a stable reference between changes.
 */
export function useInputSemanticCatalog(): InputSemanticCatalog {
    const [catalog, setCatalog] = useState<InputSemanticCatalog>(INITIAL_INPUT_SEMANTIC_CATALOG)

    useEffect(() => {
        return SlashServiceClient.subscribeToInputSemanticCatalog(EmptyRequest.create({}), {
            onResponse: (wire) => {
                const incoming = fromProtoInputSemanticCatalog(wire)
                setCatalog((current) => acceptCatalogRevision(current, incoming))
            },
            onError: (error) => console.error("Failed to observe the input semantic catalog", error),
            // The stream ends with the controller; the last catalog stays valid for this view.
            onComplete: () => {},
        })
    }, [])

    return catalog
}
