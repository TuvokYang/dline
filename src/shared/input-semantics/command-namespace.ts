import type { SlashCommandNamespace } from "./document"

/**
 * How command namespaces are spelled, in typed triggers and in descriptor
 * identities.
 *
 * Core builds discovered capability descriptors with these rules, the scanner
 * reports a node's namespace with them, and the Webview menu writes the same
 * spelling the catalog admitted. Changing a prefix here changes all three.
 */

/** Namespaces whose commands come from discovered workspace capabilities. */
export type CapabilityNamespace = Exclude<SlashCommandNamespace, "cmd">

/** A discovered capability that the catalog exposes as a command. */
export type CapabilityCommandRef =
    | { readonly namespace: "skill"; readonly name: string }
    | { readonly namespace: "workflow"; readonly name: string }
    | { readonly namespace: "mcp"; readonly server: string; readonly prompt: string }

export interface CommandIdentity {
    /** Catalog descriptor identity. */
    readonly id: string
    /** Trigger the descriptor is admitted with, sigil included. */
    readonly trigger: string
}

const TRIGGER_PREFIX: Readonly<Record<SlashCommandNamespace, string>> = {
    cmd: "/cmd:",
    workflow: "/workflow:",
    skill: "/skills:",
    mcp: "/mcp:",
}

const CAPABILITY_ID_PREFIX: Readonly<Record<CapabilityNamespace, string>> = {
    workflow: "command.workflow.",
    skill: "command.skill.",
    mcp: "command.mcp.",
}

/** The trigger that addresses `name` inside `namespace`, e.g. `/cmd:newtask` or `/mcp:server:prompt`. */
export function namespacedCommandTrigger(namespace: SlashCommandNamespace, name: string): string {
    return `${TRIGGER_PREFIX[namespace]}${name}`
}

/** Identity and trigger of the descriptor Core admits for a discovered capability. */
export function capabilityCommandIdentity(ref: CapabilityCommandRef): CommandIdentity {
    if (ref.namespace === "mcp") {
        return {
            id: `${CAPABILITY_ID_PREFIX.mcp}${ref.server}.${ref.prompt}`,
            trigger: namespacedCommandTrigger("mcp", `${ref.server}:${ref.prompt}`),
        }
    }
    return {
        id: `${CAPABILITY_ID_PREFIX[ref.namespace]}${ref.name}`,
        trigger: namespacedCommandTrigger(ref.namespace, ref.name),
    }
}

/** The namespace a descriptor identity belongs to; built-in commands are `cmd`. */
export function commandNamespaceOf(commandId: string): SlashCommandNamespace {
    const namespaces = Object.keys(CAPABILITY_ID_PREFIX) as CapabilityNamespace[]
    return namespaces.find((namespace) => commandId.startsWith(CAPABILITY_ID_PREFIX[namespace])) ?? "cmd"
}
