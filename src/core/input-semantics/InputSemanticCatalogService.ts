import {
    admitDescriptors,
    BUILTIN_INPUT_SEMANTICS,
    type CatalogConflict,
    type InputSemanticCatalog,
    type InputSemanticDescriptor,
} from "@shared/input-semantics/catalog"
import { type CapabilityCommandRef, capabilityCommandIdentity } from "@shared/input-semantics/command-namespace"
import { Logger } from "@shared/services/Logger"

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

function capabilityDescriptor(ref: CapabilityCommandRef): InputSemanticDescriptor {
    return {
        ...capabilityCommandIdentity(ref),
        kind: "command",
        payload: "text",
        // A capability command contributes instructions to the turn rather than
        // replacing it, so it may accompany mentions and other capabilities.
        composition: "combinable",
        lifecycle: "turn",
        dynamic: true,
        capability: ref,
    }
}

function projectInventory(inventory: CapabilityInventory): readonly InputSemanticDescriptor[] {
    return [
        ...inventory.skills.map((name) => capabilityDescriptor({ namespace: "skill", name })),
        ...inventory.workflows.map((name) => capabilityDescriptor({ namespace: "workflow", name })),
        ...inventory.mcpPrompts.map((entry) =>
            capabilityDescriptor({ namespace: "mcp", server: entry.server, prompt: entry.prompt }),
        ),
    ]
}

function describeConflict(conflict: CatalogConflict): string {
    const trigger = conflict.trigger === undefined ? "" : ` trigger ${conflict.trigger}`
    const holder = conflict.heldBy === undefined ? "" : ` held by ${conflict.heldBy}`
    return `${conflict.descriptorId} (${conflict.code}${trigger}${holder})`
}

function sameDescriptors(left: readonly InputSemanticDescriptor[], right: readonly InputSemanticDescriptor[]): boolean {
    if (left.length !== right.length) return false
    return left.every((descriptor, index) => JSON.stringify(descriptor) === JSON.stringify(right[index]))
}

/** Pre-discovery baseline: the built-ins are always valid, capabilities are not yet known. */
const UNDISCOVERED_REVISION = 0

/**
 * Whether the built-in `/away` command may be offered or admitted.
 *
 * Away Mode is a gated capability: while the rollout is unavailable or the user
 * has not enabled it, a task may not enter the mode, so the command must not be
 * offered and a submission must not act on it. Lexing refuses it here rather
 * than expanding it, so the Webview menu, typed input and backend admission all
 * read the same fact.
 */
export interface SemanticCommandAvailability {
    readonly awayMode: boolean
}

/** The built-in command a capability answer withdraws. */
const AWAY_COMMAND_ID = "command.away"

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

    private lastConflicts: readonly CatalogConflict[] = []

    constructor(
        private readonly port: CapabilityInventoryPort,
        private commandAvailability: SemanticCommandAvailability = { awayMode: true },
    ) {}

    current(): InputSemanticCatalog {
        return this.catalog
    }

    /**
     * Publish a new answer about gated built-in commands.
     *
     * The answer is part of the catalog, so a consumer that already cached a
     * projection learns that `/away` was withdrawn exactly as it learns about a
     * withdrawn capability: through a new revision, not through a second channel.
     */
    async setCommandAvailability(availability: SemanticCommandAvailability): Promise<InputSemanticCatalog> {
        if (availability.awayMode === this.commandAvailability.awayMode) return this.catalog
        this.commandAvailability = availability
        return this.refresh()
    }

    /**
     * Capabilities the last discovery left out of the catalog, and why.
     *
     * A refused capability is never offered or admitted, so this is the only
     * place a diagnostic surface can learn that it exists.
     */
    conflicts(): readonly CatalogConflict[] {
        return this.lastConflicts
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

    /**
     * Built-ins first, so a discovered capability can never take a built-in
     * trigger; a capability whose identity or trigger is already taken is left
     * out rather than made ambiguous.
     */
    private async compose(): Promise<readonly InputSemanticDescriptor[]> {
        const builtins = this.availableBuiltins()
        const admitted = admitDescriptors([...builtins, ...projectInventory(await this.port.readInventory())])
        this.recordConflicts(admitted.conflicts)
        return admitted.descriptors
    }

    /**
     * The built-in descriptors this device may offer.
     *
     * A gated command is removed rather than marked unavailable: an offered
     * row is inserted and sent, so the only honest way to withdraw it is to stop
     * resolving its trigger.
     */
    private availableBuiltins(): readonly InputSemanticDescriptor[] {
        if (this.commandAvailability.awayMode) return BUILTIN_INPUT_SEMANTICS
        return BUILTIN_INPUT_SEMANTICS.filter((descriptor) => descriptor.id !== AWAY_COMMAND_ID)
    }

    /** Keep the latest refusals and report them once per change, not on every refresh. */
    private recordConflicts(conflicts: readonly CatalogConflict[]): void {
        const changed = JSON.stringify(conflicts) !== JSON.stringify(this.lastConflicts)
        this.lastConflicts = conflicts
        if (!changed || conflicts.length === 0) return
        Logger.warn(
            `[SemanticInput] catalog left out ${conflicts.length} capability command(s): ${conflicts.map(describeConflict).join(", ")}`,
        )
    }
}
