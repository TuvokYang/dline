import { TemplateStore } from "../../template/TemplateStore"
import { PromptPackError } from "./errors"
import type { LanguagePack, PromptDescriptor, PromptDomain, PromptGroup } from "./types"

const PROMPT_DOMAIN_ORDER = ["system", "tools", "commands", "variants"] as const

export interface PromptRegistry {
    readonly groups: readonly PromptGroup[]
    readonly pack: LanguagePack
    readonly store: TemplateStore
}

/**
 * Creates a validated static prompt group in declaration order.
 *
 * @param name Prompt domain name.
 * @param modules Static prompt module descriptors.
 * @returns A validated immutable prompt group.
 */
export function createPromptGroup(name: PromptDomain, ...modules: readonly PromptDescriptor[]): PromptGroup {
    const moduleNames = new Set<string>()
    for (const descriptor of modules) {
        if (moduleNames.has(descriptor.name)) {
            throw new PromptPackError({
                reason: "duplicate-module",
                group: name,
                module: descriptor.name,
                source: descriptor.source,
            })
        }
        moduleNames.add(descriptor.name)
    }

    return { name, modules: [...modules] }
}

/**
 * Creates a language pack from validated static groups.
 *
 * @param groups Prompt groups in stable declaration order.
 * @returns A legacy-compatible module-to-entry language pack.
 */
/** Registers static descriptors into stable domain groups, a pack, and a template store. */
export function createPromptRegistry(...descriptors: readonly PromptDescriptor[]): PromptRegistry {
    const groups = PROMPT_DOMAIN_ORDER.map((domain) =>
        createPromptGroup(domain, ...descriptors.filter((descriptor) => descriptor.domain === domain)),
    )
    return { groups, pack: createPromptPack(...groups), store: TemplateStore.create(...groups) }
}

export function createPromptPack(...groups: readonly PromptGroup[]): LanguagePack {
    const pack: Record<string, Readonly<Record<string, string>>> = {}
    for (const group of groups) {
        for (const descriptor of group.modules) {
            if (descriptor.name in pack) {
                throw new PromptPackError({
                    reason: "duplicate-module",
                    group: group.name,
                    module: descriptor.name,
                    source: descriptor.source,
                })
            }
            pack[descriptor.name] = descriptor.prompts
        }
    }
    return pack
}
