/**
 * Input semantic catalog: the single contract describing which chat-input
 * commands and mentions exist, how their payload is written, and how they may
 * be combined in one submission.
 *
 * The catalog is owned by Core and projected to the Webview. Both sides resolve
 * a node by its stable `id` rather than by re-parsing the typed trigger, so a
 * renamed trigger or a localized label can never change admission behavior.
 */

import { type CapabilityCommandRef, commandNamespaceOf, namespacedCommandTrigger } from "./command-namespace"

/** Which trigger family a descriptor belongs to. */
export type InputSemanticKind = "command" | "mention"

/** How the argument that follows the trigger is written and validated. */
export type InputSemanticPayload =
    /** The trigger stands alone. */
    | "none"
    /** Free-form text argument, for example a report description. */
    | "text"
    /** Workspace-relative path. */
    | "path"
    /** Absolute URL. */
    | "url"
    /** Stable identity of a discovered capability, for example a skill name. */
    | "capability"

/** Whether a node may share a submission with other semantic nodes. */
export type InputSemanticComposition =
    /** May be combined freely with any other combinable node. */
    | "combinable"
    /** Must be the only semantic node in the submission. */
    | "exclusive"

/** When the effect of a node ends. */
export type InputSemanticLifecycle =
    /** Applies to the turn it was submitted with. */
    | "turn"
    /** Changes durable task state and therefore establishes a lifecycle barrier. */
    | "task"

export interface InputSemanticDescriptor {
    /** Stable identity. Never derived from a label or from user-facing text. */
    readonly id: string
    readonly kind: InputSemanticKind
    /** Literal trigger the user types, including its sigil. */
    readonly trigger: string
    /** Additional accepted triggers kept for backward compatibility. */
    readonly aliases?: readonly string[]
    readonly payload: InputSemanticPayload
    readonly composition: InputSemanticComposition
    readonly lifecycle: InputSemanticLifecycle
    /**
     * Present when the node authorizes one tool for the turn it is submitted
     * with. Admission uses this to register explicit authorization instead of
     * re-deriving intent from the raw text.
     */
    readonly authorizes?: string
    /** True when the descriptor comes from discovered workspace capabilities rather than the built-in set. */
    readonly dynamic?: boolean
    /**
     * The discovered capability a dynamic command expands, as Core recorded it.
     *
     * Core authors and consumes this; it is not projected to the Webview, which
     * only needs the trigger. Expansion reads it instead of re-reading the
     * trigger, so an MCP server or prompt name is never split out of text.
     */
    readonly capability?: CapabilityCommandRef
}

export interface InputSemanticCatalog {
    /**
     * Monotonic revision of the descriptor set. A consumer that holds an older
     * revision must refresh before it resolves a node, because a descriptor may
     * have been withdrawn with its capability.
     */
    readonly revision: number
    readonly descriptors: readonly InputSemanticDescriptor[]
}

/** Built-in command and mention descriptors that exist without workspace discovery. */
export const BUILTIN_INPUT_SEMANTICS: readonly InputSemanticDescriptor[] = [
    {
        id: "command.compact",
        kind: "command",
        trigger: "/compact",
        aliases: ["/smol"],
        payload: "none",
        composition: "exclusive",
        lifecycle: "task",
        authorizes: "summarize_task",
    },
    {
        id: "command.new_task",
        kind: "command",
        trigger: "/newtask",
        payload: "text",
        composition: "exclusive",
        lifecycle: "task",
        authorizes: "new_task",
    },
    {
        id: "command.new_rule",
        kind: "command",
        trigger: "/newrule",
        payload: "text",
        composition: "exclusive",
        lifecycle: "task",
        authorizes: "new_rule",
    },
    {
        id: "command.report_bug",
        kind: "command",
        trigger: "/reportbug",
        payload: "text",
        composition: "exclusive",
        lifecycle: "task",
        authorizes: "report_bug",
    },
    {
        id: "command.deep_planning",
        kind: "command",
        trigger: "/deep-planning",
        payload: "text",
        composition: "exclusive",
        lifecycle: "task",
        authorizes: "new_task",
    },
    {
        id: "command.explain_changes",
        kind: "command",
        trigger: "/explain-changes",
        payload: "none",
        composition: "exclusive",
        lifecycle: "turn",
    },
    {
        id: "mention.file",
        kind: "mention",
        trigger: "@",
        payload: "path",
        composition: "combinable",
        lifecycle: "turn",
    },
    {
        id: "mention.folder",
        kind: "mention",
        trigger: "@",
        payload: "path",
        composition: "combinable",
        lifecycle: "turn",
    },
    {
        id: "mention.url",
        kind: "mention",
        trigger: "@http",
        payload: "url",
        composition: "combinable",
        lifecycle: "turn",
    },
    {
        id: "mention.problems",
        kind: "mention",
        trigger: "@problems",
        payload: "none",
        composition: "combinable",
        lifecycle: "turn",
    },
    {
        id: "mention.terminal",
        kind: "mention",
        trigger: "@terminal",
        payload: "none",
        composition: "combinable",
        lifecycle: "turn",
    },
    {
        id: "mention.git_changes",
        kind: "mention",
        trigger: "@git-changes",
        payload: "none",
        composition: "combinable",
        lifecycle: "turn",
    },
    {
        id: "mention.git_commit",
        kind: "mention",
        trigger: "@",
        payload: "text",
        composition: "combinable",
        lifecycle: "turn",
    },
]

/**
 * Characters a command trigger may contain after its sigil, as a regular
 * expression character class body. The scanner builds its command token from
 * this set, so a trigger outside it could be offered but never recognized.
 */
export const COMMAND_TRIGGER_CHARS = "a-zA-Z0-9_.:@-"

const COMMAND_TRIGGER = new RegExp(`^/[${COMMAND_TRIGGER_CHARS}]+$`)

/** True when the scanner can recognize the trigger as exactly one command token. */
export function isCommandTrigger(trigger: string): boolean {
    return COMMAND_TRIGGER.test(trigger)
}

/**
 * Every trigger a command descriptor answers to: the canonical one first, then
 * its aliases, then - for a built-in command - each of those spelled in the
 * `cmd` namespace.
 *
 * The composer menu inserts the namespaced spelling (`/cmd:reportbug`) for a
 * built-in the user picked by its bare name, so that spelling is derived from
 * the namespace rule rather than listed by hand: a built-in added later can
 * never be offered by the menu yet refused as plain text.
 */
export function commandTriggersOf(descriptor: InputSemanticDescriptor): readonly string[] {
    if (descriptor.kind !== "command") return []
    const spelled = [descriptor.trigger, ...(descriptor.aliases ?? [])]
    if (commandNamespaceOf(descriptor.id) !== "cmd") return spelled
    const namespaced = spelled.filter(isBareTrigger).map((trigger) => namespacedCommandTrigger("cmd", trigger.slice(1)))
    return [...spelled, ...namespaced.filter((trigger) => !spelled.includes(trigger))]
}

/** A trigger written without a namespace, such as `/compact` rather than `/cmd:compact`. */
function isBareTrigger(trigger: string): boolean {
    return trigger.startsWith("/") && !trigger.includes(":")
}

/**
 * Resolve a typed command token to its descriptor.
 *
 * Matching is case-sensitive and covers the canonical trigger and its aliases;
 * admission guarantees that at most one descriptor holds a given trigger.
 */
export function resolveCommandTrigger(catalog: InputSemanticCatalog, trigger: string): InputSemanticDescriptor | undefined {
    return catalog.descriptors.find((descriptor) => commandTriggersOf(descriptor).includes(trigger))
}

/** The same resolution as {@link resolveCommandTrigger}, indexed once for resolving many tokens against one revision. */
export function indexCommandTriggers(catalog: InputSemanticCatalog): ReadonlyMap<string, InputSemanticDescriptor> {
    const index = new Map<string, InputSemanticDescriptor>()
    for (const descriptor of catalog.descriptors) {
        for (const trigger of commandTriggersOf(descriptor)) {
            if (!index.has(trigger)) index.set(trigger, descriptor)
        }
    }
    return index
}

/** Why a descriptor was refused a place in the catalog. */
export interface CatalogConflict {
    readonly code: "duplicate_id" | "duplicate_trigger" | "invalid_trigger"
    /** The refused descriptor. */
    readonly descriptorId: string
    /** The descriptor that already holds the identity or trigger; absent when the trigger itself is invalid. */
    readonly heldBy?: string
    readonly trigger?: string
}

export interface AdmittedDescriptors {
    readonly descriptors: readonly InputSemanticDescriptor[]
    readonly conflicts: readonly CatalogConflict[]
}

/**
 * Admit descriptors in order, refusing any whose identity or command trigger is
 * already taken, or whose command trigger the scanner could never recognize.
 *
 * A typed command must resolve to exactly one descriptor, so a trigger or alias
 * may belong to one command only; matching stays case-sensitive. Earlier
 * descriptors win, which lets the built-ins listed first never be shadowed by a
 * discovered capability. Mention descriptors share their sigil by design and
 * resolve by identity, so only their identities must be unique.
 */
export function admitDescriptors(candidates: readonly InputSemanticDescriptor[]): AdmittedDescriptors {
    const descriptors: InputSemanticDescriptor[] = []
    const conflicts: CatalogConflict[] = []
    const ids = new Set<string>()
    const triggers = new Map<string, string>()

    for (const descriptor of candidates) {
        if (ids.has(descriptor.id)) {
            conflicts.push({ code: "duplicate_id", descriptorId: descriptor.id, heldBy: descriptor.id })
            continue
        }
        const commandTriggers = commandTriggersOf(descriptor)
        // A capability named with spaces or punctuation would be offered by the
        // menu and then sent as plain text, so it never enters the catalog.
        const unrecognizable = commandTriggers.find((trigger) => !isCommandTrigger(trigger))
        if (unrecognizable !== undefined) {
            conflicts.push({ code: "invalid_trigger", descriptorId: descriptor.id, trigger: unrecognizable })
            continue
        }
        const taken = commandTriggers.find((trigger) => triggers.has(trigger))
        if (taken !== undefined) {
            conflicts.push({
                code: "duplicate_trigger",
                descriptorId: descriptor.id,
                heldBy: triggers.get(taken) ?? "",
                trigger: taken,
            })
            continue
        }
        ids.add(descriptor.id)
        for (const trigger of commandTriggers) triggers.set(trigger, descriptor.id)
        descriptors.push(descriptor)
    }
    return { descriptors, conflicts }
}

export interface CatalogCompositionViolation {
    readonly code: "exclusive_node_combined" | "unknown_node"
    readonly nodeId: string
}

/** Resolve one descriptor by its stable identity. */
export function findDescriptor(catalog: InputSemanticCatalog, nodeId: string): InputSemanticDescriptor | undefined {
    return catalog.descriptors.find((descriptor) => descriptor.id === nodeId)
}

/**
 * Validate one submission's node set against the composition policy.
 *
 * An exclusive node changes durable task state, so it cannot share a
 * submission: the user would otherwise have no way to tell which effect the
 * turn actually authorized.
 */
export function validateComposition(
    catalog: InputSemanticCatalog,
    nodeIds: readonly string[],
): readonly CatalogCompositionViolation[] {
    const violations: CatalogCompositionViolation[] = []
    const resolved: InputSemanticDescriptor[] = []
    for (const nodeId of nodeIds) {
        const descriptor = findDescriptor(catalog, nodeId)
        if (!descriptor) {
            violations.push({ code: "unknown_node", nodeId })
            continue
        }
        resolved.push(descriptor)
    }
    if (resolved.length > 1) {
        for (const descriptor of resolved) {
            if (descriptor.composition === "exclusive") {
                violations.push({ code: "exclusive_node_combined", nodeId: descriptor.id })
            }
        }
    }
    return violations
}

/** True when the node set establishes a task lifecycle barrier for the submission. */
export function establishesLifecycleBarrier(catalog: InputSemanticCatalog, nodeIds: readonly string[]): boolean {
    return nodeIds.some((nodeId) => findDescriptor(catalog, nodeId)?.lifecycle === "task")
}

/** Tools that the node set explicitly authorizes for its turn. */
export function authorizedTools(catalog: InputSemanticCatalog, nodeIds: readonly string[]): readonly string[] {
    const tools = nodeIds
        .map((nodeId) => findDescriptor(catalog, nodeId)?.authorizes)
        .filter((tool): tool is string => tool !== undefined)
    return [...new Set(tools)]
}
