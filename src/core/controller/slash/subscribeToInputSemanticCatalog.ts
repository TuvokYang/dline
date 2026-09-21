import type { InputSemanticCatalog } from "@shared/input-semantics/catalog"
import type { EmptyRequest } from "@shared/proto/dline/common"
import type { InputSemanticCatalog as WireCatalog } from "@shared/proto/dline/slash"
import { toProtoInputSemanticCatalog } from "@shared/proto-conversions/input-semantics/catalog"
import { Logger } from "@/shared/services/Logger"
import { getRequestRegistry, type StreamingResponseHandler } from "../grpc-handler"
import type { Controller } from "../index"
import { refreshInputSemanticCatalog } from "./input-semantic-catalog"

// Per-controller subscriptions to isolate catalogs between independent webviews.
const subs = new Map<Controller, Set<StreamingResponseHandler<WireCatalog>>>()

/**
 * Subscribe to input semantic catalog revisions for a specific controller.
 *
 * The subscriber receives the current catalog immediately so it never composes
 * against an empty set while waiting for the first capability change.
 */
export async function subscribeToInputSemanticCatalog(
	controller: Controller,
	_request: EmptyRequest,
	responseStream: StreamingResponseHandler<WireCatalog>,
	requestId?: string,
): Promise<void> {
	let set = subs.get(controller)
	if (!set) {
		set = new Set()
		subs.set(controller, set)
	}
	set.add(responseStream)

	const cleanup = () => {
		const current = subs.get(controller)
		if (current) {
			current.delete(responseStream)
			if (current.size === 0) subs.delete(controller)
		}
	}

	if (requestId) {
		getRequestRegistry().registerRequest(requestId, cleanup, { type: "inputSemanticCatalog_subscription" }, responseStream)
	}

	const { catalog, changed } = await refreshInputSemanticCatalog(controller)
	// A revision that moved during this refresh belongs to every subscriber; an
	// unchanged catalog only needs to reach the stream that just attached.
	if (changed) {
		await sendInputSemanticCatalogEvent(controller, catalog)
		return
	}

	try {
		await responseStream(toProtoInputSemanticCatalog(catalog), false)
	} catch (error) {
		Logger.error("Error sending initial input semantic catalog:", error)
		cleanup()
	}
}

/**
 * Rediscover capabilities and notify subscribers when the revision advanced.
 *
 * Publication is the only reason to broadcast: a consumer keeps its cached
 * projection while nothing about the available nodes moved.
 */
export async function publishInputSemanticCatalog(controller: Controller): Promise<InputSemanticCatalog> {
	const { catalog, changed } = await refreshInputSemanticCatalog(controller)
	if (changed) await sendInputSemanticCatalogEvent(controller, catalog)
	return catalog
}

/** Send a catalog revision to a specific controller's subscribers. */
export async function sendInputSemanticCatalogEvent(controller: Controller, catalog: InputSemanticCatalog): Promise<void> {
	const set = subs.get(controller)
	if (!set || set.size === 0) return

	const wire = toProtoInputSemanticCatalog(catalog)
	await Promise.all(
		Array.from(set).map(async (responseStream) => {
			try {
				await responseStream(wire, false)
			} catch (error) {
				Logger.error("Error sending input semantic catalog event:", error)
				set.delete(responseStream)
			}
		}),
	)
}
