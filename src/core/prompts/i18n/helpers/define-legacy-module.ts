import type { PromptContract } from "../../template/types"
import { definePromptModule } from "./define-module"
import type { PromptDescriptor, PromptDomain, PromptEntries } from "./types"

/** Adapts one statically imported legacy prompt map into a validated descriptor. */
export function defineLegacyModule<Name extends string, Entries extends PromptEntries>(
    name: Name,
    domain: PromptDomain,
    prompts: Entries,
    contracts: Readonly<Record<string, PromptContract | undefined>> = {},
    source = `i18n/en/${domain}/${name}.ts`,
): PromptDescriptor<Name, Entries> {
    const allowEmptyKeys = Object.entries(prompts)
        .filter(([, value]) => value.length === 0)
        .map(([key]) => key)
    return definePromptModule({ name, domain, prompts, contracts, source, allowEmptyKeys })
}
