import { BUILTIN_INPUT_SEMANTICS, type InputSemanticCatalog, type InputSemanticDescriptor } from "@shared/input-semantics/catalog"

/** Discovered workspace capabilities that extend the built-in semantic set. */
export interface CapabilityInventory {
	readonly skills: readonly string[]
	readonly workflows: readonly string[]
	readonly mcpPrompts: readonly { readonly server: string; readonly prompt: string }[]
}

export interface CapabilityInventoryPort {
	/**
	 * Read the currently enabled capabilities.
	 *
	 * Discovery reaches workspace files and MCP connections, so it is
	 * asynchronous and strictly read-only: it must never mutate a toggle.
	 */
	readInventory(): Promise<CapabilityInventory>
}

function capabilityDescriptor(id: string, trigger: string, authorizes: string | undefined): InputSemanticDescriptor {
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

/** Pre-discovery baseline: the built-ins are always valid, capabilities are not yet known. */
const UNDISCOVERED_REVISION = 0

/**
 * Core owner of the input semantic catalog.
 *
 * The revision is the contract the Webview and admission share: it advances
 * only when the descriptor set actually changed, so a consumer can cache a
 * projection and still detect a capability that was withdrawn. Revision 0 means
 * discovery has not run yet, so a consumer can tell "no capabilities" apart
 * from "not asked yet".
 */
export class InputSemanticCatalogService {
	private catalog: InputSemanticCatalog = {
		revision: UNDISCOVERED_REVISION,
		descriptors: BUILTIN_INPUT_SEMANTICS,
	}

	private firstDiscovery?: Promise<InputSemanticCatalog>

	constructor(private readonly port: CapabilityInventoryPort) {}

	current(): InputSemanticCatalog {
		return this.catalog
	}

	/**
	 * Return a catalog that has seen discovery at least once.
	 *
	 * A submission may arrive before any consumer asked for the catalog. Lexing
	 * against the pre-discovery baseline would silently demote a real skill,
	 * workflow or MCP prompt to plain text, so the first caller waits for one
	 * discovery instead. Later callers reuse the published catalog, and the
	 * in-flight promise is shared so a burst of submissions triggers one pass.
	 */
	async discovered(): Promise<InputSemanticCatalog> {
		if (this.catalog.revision !== UNDISCOVERED_REVISION) return this.catalog
		this.firstDiscovery ??= this.refresh().finally(() => {
			this.firstDiscovery = undefined
		})
		return this.firstDiscovery
	}

	/** Recompute the descriptor set and return the catalog, advancing the revision only on a real change. */
	async refresh(): Promise<InputSemanticCatalog> {
		const descriptors = await this.compose()
		const published = this.catalog.revision !== UNDISCOVERED_REVISION
		if (published && sameDescriptors(descriptors, this.catalog.descriptors)) return this.catalog
		this.catalog = { revision: this.catalog.revision + 1, descriptors }
		return this.catalog
	}

	private async compose(): Promise<readonly InputSemanticDescriptor[]> {
		return [...BUILTIN_INPUT_SEMANTICS, ...projectInventory(await this.port.readInventory())]
	}
}
