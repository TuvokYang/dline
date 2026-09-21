import {
	BUILTIN_INPUT_SEMANTICS,
	type InputSemanticCatalog,
	type InputSemanticDescriptor,
} from "@shared/input-semantics/catalog"

/** Discovered workspace capabilities that extend the built-in semantic set. */
export interface CapabilityInventory {
	readonly skills: readonly string[]
	readonly workflows: readonly string[]
	readonly mcpPrompts: readonly { readonly server: string; readonly prompt: string }[]
}

export interface CapabilityInventoryPort {
	/** Read the currently enabled capabilities. Discovery is read-only and must not mutate toggles. */
	readInventory(): CapabilityInventory
}

function capabilityDescriptor(
	id: string,
	trigger: string,
	authorizes: string | undefined,
): InputSemanticDescriptor {
	return {
		id,
		kind: "command",
		trigger,
		payload: "text",
		// A capability command contributes instructions to the turn rather than
		// replacing it, so it may accompany mentions and other capabilities.
		composition: "combinable",
		lifecycle: "turn",
		authorizes,
		dynamic: true,
	}
}

function projectInventory(inventory: CapabilityInventory): readonly InputSemanticDescriptor[] {
	return [
		...inventory.skills.map((skill) => capabilityDescriptor(`command.skill.${skill}`, `/skills:${skill}`, undefined)),
		...inventory.workflows.map((workflow) =>
			capabilityDescriptor(`command.workflow.${workflow}`, `/workflow:${workflow}`, undefined),
		),
		...inventory.mcpPrompts.map((entry) =>
			capabilityDescriptor(
				`command.mcp.${entry.server}.${entry.prompt}`,
				`/mcp:${entry.server}:${entry.prompt}`,
				undefined,
			),
		),
	]
}

function sameDescriptors(left: readonly InputSemanticDescriptor[], right: readonly InputSemanticDescriptor[]): boolean {
	if (left.length !== right.length) return false
	return left.every((descriptor, index) => JSON.stringify(descriptor) === JSON.stringify(right[index]))
}

/**
 * Core owner of the input semantic catalog.
 *
 * The revision is the contract the Webview and admission share: it advances
 * only when the descriptor set actually changed, so a consumer can cache a
 * projection and still detect a capability that was withdrawn.
 */
export class InputSemanticCatalogService {
	private catalog: InputSemanticCatalog

	constructor(private readonly port: CapabilityInventoryPort) {
		this.catalog = { revision: 1, descriptors: this.compose() }
	}

	current(): InputSemanticCatalog {
		return this.catalog
	}

	/** Recompute the descriptor set and return the catalog, advancing the revision only on a real change. */
	refresh(): InputSemanticCatalog {
		const descriptors = this.compose()
		if (sameDescriptors(descriptors, this.catalog.descriptors)) return this.catalog
		this.catalog = { revision: this.catalog.revision + 1, descriptors }
		return this.catalog
	}

	private compose(): readonly InputSemanticDescriptor[] {
		return [...BUILTIN_INPUT_SEMANTICS, ...projectInventory(this.port.readInventory())]
	}
}
