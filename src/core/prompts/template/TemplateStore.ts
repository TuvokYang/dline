import type { PromptDescriptor, PromptGroup } from "../i18n/helpers/types"
import { PromptTemplate } from "./PromptTemplate"
import type { PromptContract } from "./types"

export type TemplateStoreErrorReason = "missing-template" | "duplicate-template"

export interface TemplateStoreErrorData {
    readonly templateId: string
    readonly reason: TemplateStoreErrorReason
    readonly source?: string
}

interface TemplateEntry {
    readonly template: string
    readonly contract: PromptContract
    readonly source: string
}

const EMPTY_CONTRACT: PromptContract = { variables: {} }

/** Reports missing or duplicate static template registrations. */
export class TemplateStoreError extends Error {
    public readonly templateId: string
    public readonly reason: TemplateStoreErrorReason
    public readonly source?: string

    /**
     * Creates a structured template store error.
     *
     * @param data Invalid template store operation details.
     */
    public constructor(data: TemplateStoreErrorData) {
        super(`Template store ${data.reason} template=${data.templateId}${data.source ? ` source=${data.source}` : ""}`)
        this.name = "TemplateStoreError"
        this.templateId = data.templateId
        this.reason = data.reason
        this.source = data.source
    }
}

/** Indexes statically imported prompt descriptors by stable template ID. */
export class TemplateStore {
    /**
     * Creates a template store from static prompt groups.
     *
     * @param groups Static prompt groups in declaration order.
     * @returns A validated immutable template store.
     */
    public static create(...groups: readonly PromptGroup[]): TemplateStore {
        const entries = new Map<string, TemplateEntry>()
        for (const group of groups) {
            for (const descriptor of group.modules) {
                TemplateStore.addDescriptor(entries, descriptor)
            }
        }
        return new TemplateStore(entries)
    }

    /**
     * Adds one descriptor to a template entry index.
     *
     * @param entries Mutable construction index owned by the factory.
     * @param descriptor Static prompt descriptor.
     */
    private static addDescriptor(entries: Map<string, TemplateEntry>, descriptor: PromptDescriptor): void {
        for (const [key, template] of Object.entries(descriptor.prompts)) {
            const templateId = `${descriptor.name}.${key}`
            if (entries.has(templateId)) {
                throw new TemplateStoreError({
                    templateId,
                    reason: "duplicate-template",
                    source: descriptor.source,
                })
            }
            entries.set(templateId, {
                template,
                contract: descriptor.contracts[key] ?? EMPTY_CONTRACT,
                source: descriptor.source,
            })
        }
    }

    /**
     * Creates an immutable template store snapshot.
     *
     * @param entries Static template entry index.
     */
    private constructor(private readonly entries: ReadonlyMap<string, TemplateEntry>) {}

    /**
     * Loads a raw template and contract by stable ID.
     *
     * @param templateId Stable module.key template identifier.
     * @returns An empty immutable prompt template.
     */
    public load(templateId: string): PromptTemplate {
        const entry = this.entries.get(templateId)
        if (!entry) {
            throw new TemplateStoreError({ templateId, reason: "missing-template" })
        }
        return PromptTemplate.create(templateId, entry.template, entry.contract)
    }
}
