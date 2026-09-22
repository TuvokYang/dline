import type { InputSemanticCatalog } from "@shared/input-semantics/catalog"
import { EmptyRequest } from "@shared/proto/dline/common"
import { Logger } from "@shared/services/Logger"
import {
	type CapabilityInventory,
	type CapabilityInventoryPort,
	InputSemanticCatalogService,
} from "@/core/input-semantics/InputSemanticCatalogService"
import { refreshRules } from "../file/refreshRules"
import type { Controller } from "../index"
import { getAvailableSlashCommands } from "./getAvailableSlashCommands"

/** Sections produced by slash-command discovery that carry a capability identity. */
const SKILL_SECTION = "skill"
const WORKFLOW_SECTION = "workflow"

/** A discovered slash command, reduced to the fields the catalog needs. */
interface DiscoveredCommand {
	readonly name: string
	readonly section: string
}

/** A connected MCP server, reduced to the fields the catalog needs. */
interface DiscoveredMcpServer {
	readonly name: string
	readonly prompts?: readonly { readonly name: string }[]
}

/**
 * Reduce discovery output to the capability inventory.
 *
 * Kept pure so the mapping is testable without a Controller, and so the toggle
 * precedence stays owned by slash-command discovery instead of being re-derived.
 */
export function capabilityInventoryFrom(
	commands: readonly DiscoveredCommand[],
	servers: readonly DiscoveredMcpServer[],
): CapabilityInventory {
	const named = (section: string) => commands.filter((command) => command.section === section).map((command) => command.name)
	return {
		skills: named(SKILL_SECTION),
		workflows: named(WORKFLOW_SECTION),
		mcpPrompts: servers.flatMap((server) =>
			(server.prompts ?? []).map((prompt) => ({ server: server.name, prompt: prompt.name })),
		),
	}
}

/**
 * Reads the capabilities this controller advertises for autocomplete.
 *
 * Discovery runs first: slash-command listing reads the last trustworthy scan,
 * and before any scan exists a real workspace skill or workflow would be absent.
 * A submission that arrives in a fresh window would then lex a genuine command
 * as plain text, so the inventory owns that scan instead of hoping it already ran.
 */
class ControllerCapabilityInventory implements CapabilityInventoryPort {
	constructor(private readonly controller: Controller) {}

	async readInventory(): Promise<CapabilityInventory> {
		await this.scanCapabilities()
		const { commands } = await getAvailableSlashCommands(this.controller, EmptyRequest.create({}))
		return capabilityInventoryFrom(commands, this.controller.getMcpServersForOwner())
	}

	/**
	 * Run the shared capability scan.
	 *
	 * `refreshRules` already coalesces concurrent callers, so a submission that
	 * races the capability panel joins the in-flight scan. A failed scan must not
	 * block admission; listing then falls back to the stored toggles.
	 */
	private async scanCapabilities(): Promise<void> {
		try {
			await refreshRules(this.controller, EmptyRequest.create({}))
		} catch (error) {
			Logger.warn(`[InputSemanticCatalog] capability discovery failed: ${error}`)
		}
	}
}

// One catalog per controller, because capability toggles are workspace and task scoped.
const services = new WeakMap<Controller, InputSemanticCatalogService>()

export function inputSemanticCatalogService(controller: Controller): InputSemanticCatalogService {
	let service = services.get(controller)
	if (!service) {
		service = new InputSemanticCatalogService(new ControllerCapabilityInventory(controller))
		services.set(controller, service)
	}
	return service
}

export interface CatalogRefresh {
	readonly catalog: InputSemanticCatalog
	/** True when this refresh advanced the revision, so a cached consumer must be told. */
	readonly changed: boolean
}

/**
 * Rediscover capabilities for this controller.
 *
 * This owner stays transport-agnostic: it reports whether the revision moved
 * and leaves publication to the subscription module.
 */
export async function refreshInputSemanticCatalog(controller: Controller): Promise<CatalogRefresh> {
	const service = inputSemanticCatalogService(controller)
	const previousRevision = service.current().revision
	const catalog = await service.refresh()
	return { catalog, changed: catalog.revision !== previousRevision }
}
