import type { PromptContract } from "../../template/types"

export type PromptDomain = "system" | "tools" | "commands" | "variants"
export type PromptEntries = Readonly<Record<string, string>>

export interface PromptDescriptor<Name extends string = string, Entries extends PromptEntries = PromptEntries> {
    readonly name: Name
    readonly domain: PromptDomain
    readonly prompts: Entries
    readonly contracts: Readonly<Record<string, PromptContract | undefined>>
    readonly source: string
    readonly allowEmptyKeys?: readonly string[]
}

export interface PromptGroup {
    readonly name: PromptDomain
    readonly modules: readonly PromptDescriptor[]
}

export type LanguagePack = Readonly<Record<string, PromptEntries>>

export type PromptPackIssueReason = "missing-module" | "extra-module" | "missing-key" | "extra-key"

export interface PromptPackIssue {
    readonly language: string
    readonly reason: PromptPackIssueReason
    readonly module: string
    readonly key?: string
}
