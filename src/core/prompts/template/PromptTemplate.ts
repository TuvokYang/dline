import { EnvStore } from "./EnvStore"
import { PromptScanner } from "./PromptScanner"
import type { EnvStage, PromptContract, PromptEnv, PromptOutput, PromptWarning } from "./types"

/** Combines a raw template with immutable environment snapshots. */
export class PromptTemplate {
    /**
     * Creates an empty prompt template instance.
     *
     * @param templateId Stable template identifier.
     * @param template Raw prompt template.
     * @param contract Variable and stage contract.
     * @returns An immutable prompt template.
     */
    public static create(templateId: string, template: string, contract: PromptContract): PromptTemplate {
        return new PromptTemplate(templateId, template, EnvStore.create(templateId, contract), new PromptScanner())
    }

    /**
     * Creates an immutable prompt template snapshot.
     *
     * @param templateId Stable template identifier.
     * @param template Raw prompt template.
     * @param store Immutable environment snapshot.
     * @param scanner Shared stateless prompt scanner.
     */
    private constructor(
        private readonly templateId: string,
        private readonly template: string,
        private readonly store: EnvStore,
        private readonly scanner: PromptScanner,
    ) {}

    /**
     * Loads environment values into a new prompt template snapshot.
     *
     * @param stage Environment loading stage.
     * @param values Typed prompt primitive values.
     * @param source Stable source label for diagnostics.
     * @returns A new immutable prompt template.
     */
    public env(stage: EnvStage, values: PromptEnv, source: string): PromptTemplate {
        return new PromptTemplate(this.templateId, this.template, this.store.env(stage, values, source), this.scanner)
    }

    /**
     * Generates final prompt text from one immutable environment snapshot.
     *
     * @returns Rendered text, missing token warnings, and environment trace.
     */
    public generate(): PromptOutput {
        const missingKeys = new Set<string>()
        const text = this.scanner.render(
            this.template,
            (key) => {
                const value = this.store.get(key)
                return value === undefined ? undefined : String(value)
            },
            (key) => missingKeys.add(key),
        )
        const loadedStages = this.store.getLoadedStages()
        const warnings: readonly PromptWarning[] = [...missingKeys].map((key) => ({
            templateId: this.templateId,
            key,
            rule: this.store.getRule(key),
            loadedStages: [...loadedStages],
            trace: this.store.getKeyTrace(key),
        }))

        return {
            text,
            warnings,
            trace: this.store.getTrace(),
        }
    }
}
