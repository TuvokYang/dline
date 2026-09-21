import type {
	InputSemanticCatalog,
	InputSemanticComposition,
	InputSemanticDescriptor,
	InputSemanticKind,
	InputSemanticLifecycle,
	InputSemanticPayload,
} from "@shared/input-semantics/catalog"
import {
	InputSemanticCatalog as WireCatalog,
	InputSemanticComposition as WireComposition,
	InputSemanticDescriptor as WireDescriptor,
	InputSemanticKind as WireKind,
	InputSemanticLifecycle as WireLifecycle,
	InputSemanticPayload as WirePayload,
} from "@shared/proto/dline/slash"

const KIND_TO_WIRE: Record<InputSemanticKind, WireKind> = {
	command: WireKind.INPUT_SEMANTIC_KIND_COMMAND,
	mention: WireKind.INPUT_SEMANTIC_KIND_MENTION,
}

const PAYLOAD_TO_WIRE: Record<InputSemanticPayload, WirePayload> = {
	none: WirePayload.INPUT_SEMANTIC_PAYLOAD_NONE,
	text: WirePayload.INPUT_SEMANTIC_PAYLOAD_TEXT,
	path: WirePayload.INPUT_SEMANTIC_PAYLOAD_PATH,
	url: WirePayload.INPUT_SEMANTIC_PAYLOAD_URL,
	capability: WirePayload.INPUT_SEMANTIC_PAYLOAD_CAPABILITY,
}

const COMPOSITION_TO_WIRE: Record<InputSemanticComposition, WireComposition> = {
	combinable: WireComposition.INPUT_SEMANTIC_COMPOSITION_COMBINABLE,
	exclusive: WireComposition.INPUT_SEMANTIC_COMPOSITION_EXCLUSIVE,
}

const LIFECYCLE_TO_WIRE: Record<InputSemanticLifecycle, WireLifecycle> = {
	turn: WireLifecycle.INPUT_SEMANTIC_LIFECYCLE_TURN,
	task: WireLifecycle.INPUT_SEMANTIC_LIFECYCLE_TASK,
}

function invert<Domain extends string, Wire extends number>(map: Record<Domain, Wire>): ReadonlyMap<Wire, Domain> {
	return new Map((Object.entries(map) as [Domain, Wire][]).map(([domain, wire]) => [wire, domain]))
}

const WIRE_TO_KIND = invert(KIND_TO_WIRE)
const WIRE_TO_PAYLOAD = invert(PAYLOAD_TO_WIRE)
const WIRE_TO_COMPOSITION = invert(COMPOSITION_TO_WIRE)
const WIRE_TO_LIFECYCLE = invert(LIFECYCLE_TO_WIRE)

export function toProtoInputSemanticDescriptor(descriptor: InputSemanticDescriptor): WireDescriptor {
	return WireDescriptor.create({
		id: descriptor.id,
		kind: KIND_TO_WIRE[descriptor.kind],
		trigger: descriptor.trigger,
		aliases: descriptor.aliases ? [...descriptor.aliases] : [],
		payload: PAYLOAD_TO_WIRE[descriptor.payload],
		composition: COMPOSITION_TO_WIRE[descriptor.composition],
		lifecycle: LIFECYCLE_TO_WIRE[descriptor.lifecycle],
		authorizes: descriptor.authorizes ?? "",
		dynamic: descriptor.dynamic ?? false,
	})
}

/**
 * Convert one wire descriptor back to the domain model.
 *
 * Returns undefined when the wire carries an enum this build cannot interpret:
 * a consumer must drop an unknown node rather than guess a policy that could
 * authorize a tool or lift an exclusivity constraint.
 */
export function fromProtoInputSemanticDescriptor(descriptor: WireDescriptor): InputSemanticDescriptor | undefined {
	const kind = WIRE_TO_KIND.get(descriptor.kind)
	const payload = WIRE_TO_PAYLOAD.get(descriptor.payload)
	const composition = WIRE_TO_COMPOSITION.get(descriptor.composition)
	const lifecycle = WIRE_TO_LIFECYCLE.get(descriptor.lifecycle)
	if (!kind || !payload || !composition || !lifecycle) return undefined

	return {
		id: descriptor.id,
		kind,
		trigger: descriptor.trigger,
		payload,
		composition,
		lifecycle,
		...(descriptor.aliases.length > 0 ? { aliases: [...descriptor.aliases] } : {}),
		...(descriptor.authorizes ? { authorizes: descriptor.authorizes } : {}),
		...(descriptor.dynamic ? { dynamic: true } : {}),
	}
}

export function toProtoInputSemanticCatalog(catalog: InputSemanticCatalog): WireCatalog {
	return WireCatalog.create({
		revision: catalog.revision,
		descriptors: catalog.descriptors.map(toProtoInputSemanticDescriptor),
	})
}

export function fromProtoInputSemanticCatalog(catalog: WireCatalog): InputSemanticCatalog {
	const descriptors: InputSemanticDescriptor[] = []
	for (const descriptor of catalog.descriptors) {
		const converted = fromProtoInputSemanticDescriptor(descriptor)
		if (converted) descriptors.push(converted)
	}
	return { revision: catalog.revision, descriptors }
}
