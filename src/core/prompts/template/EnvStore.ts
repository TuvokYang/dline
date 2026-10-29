import { PromptEnvError } from "./errors"
import type { EnvRule, EnvStage, EnvTrace, PromptContract, PromptEnvInput, PromptInputValue, PromptValue } from "./types"

const STAGE_ORDER: Readonly<Record<EnvStage, number>> = {
    base: 0,
    variant: 1,
    runtime: 2,
}

interface EnvEntry {
    readonly value: PromptValue
    readonly stage: EnvStage
    readonly source: string
}

/** Stores validated prompt environment values as immutable snapshots. */
export class EnvStore {
    private readonly entries: ReadonlyMap<string, EnvEntry>
    private readonly trace: readonly EnvTrace[]
    private readonly loadedStages: readonly EnvStage[]
    private readonly currentStage?: EnvStage

    /**
     * Creates an empty environment store for a template contract.
     *
     * @param templateId Stable template identifier.
     * @param contract Variable and stage contract.
     * @returns An empty immutable environment store.
     */
    public static create(templateId: string, contract: PromptContract): EnvStore {
        return new EnvStore(templateId, contract, new Map(), [], [], undefined)
    }

    /**
     * Creates an immutable environment snapshot.
     *
     * @param templateId Stable template identifier.
     * @param contract Variable and stage contract.
     * @param entries Validated environment entries.
     * @param trace Ordered environment write trace.
     * @param loadedStages Stages loaded into the snapshot.
     * @param currentStage Latest loaded stage.
     */
    private constructor(
        private readonly templateId: string,
        private readonly contract: PromptContract,
        entries: ReadonlyMap<string, EnvEntry>,
        trace: readonly EnvTrace[],
        loadedStages: readonly EnvStage[],
        currentStage: EnvStage | undefined,
    ) {
        this.entries = entries
        this.trace = trace
        this.loadedStages = loadedStages
        this.currentStage = currentStage
    }

    /**
     * Loads validated values into a new environment snapshot.
     *
     * @param stage Environment loading stage.
     * @param values Values to validate and load.
     * @param source Stable source label for diagnostics.
     * @returns A new immutable environment store.
     */
    public env(stage: EnvStage, values: PromptEnvInput, source: string): EnvStore {
        this.assertStage(stage, source)

        const nextEntries = new Map(this.entries)
        const nextTrace = [...this.trace]
        for (const [key, input] of Object.entries(values)) {
            const value = this.validateValue(key, stage, input, source)
            const replaced = nextEntries.get(key)
            nextEntries.set(key, { value, stage, source })
            nextTrace.push({
                key,
                stage,
                source,
                ...(replaced ? { replacedSource: replaced.source } : {}),
            })
        }

        const nextStages = this.loadedStages.includes(stage) ? [...this.loadedStages] : [...this.loadedStages, stage]
        return new EnvStore(this.templateId, this.contract, nextEntries, nextTrace, nextStages, stage)
    }

    /**
     * Reads a final environment value.
     *
     * @param key Contract variable key.
     * @returns The final value or undefined when not loaded.
     */
    public get(key: string): PromptValue | undefined {
        return this.entries.get(key)?.value
    }

    /**
     * Returns an isolated ordered write trace.
     *
     * @returns Environment write trace.
     */
    public getTrace(): readonly EnvTrace[] {
        return this.trace.map((entry) => ({ ...entry }))
    }

    /**
     * Returns an isolated trace for one contract key.
     *
     * @param key Contract variable key.
     * @returns Environment writes for the key.
     */
    public getKeyTrace(key: string): readonly EnvTrace[] {
        return this.trace.filter((entry) => entry.key === key).map((entry) => ({ ...entry }))
    }

    /**
     * Returns an isolated variable rule.
     *
     * @param key Contract variable key.
     * @returns A copied rule or undefined for undeclared keys.
     */
    public getRule(key: string): EnvRule | undefined {
        const rule = this.contract.variables[key]
        return rule ? { stages: [...rule.stages], required: rule.required } : undefined
    }

    /**
     * Returns loaded stages in first-load order.
     *
     * @returns Loaded environment stages.
     */
    public getLoadedStages(): readonly EnvStage[] {
        return [...this.loadedStages]
    }

    /**
     * Rejects loading a stage before the current snapshot stage.
     *
     * @param stage Requested stage.
     * @param source Stable source label.
     */
    private assertStage(stage: EnvStage, source: string): void {
        if (this.currentStage && STAGE_ORDER[stage] < STAGE_ORDER[this.currentStage]) {
            throw new PromptEnvError({
                templateId: this.templateId,
                stage,
                source,
                reason: "stage-regression",
            })
        }
    }

    /**
     * Validates a contract key, stage, and primitive value.
     *
     * @param key Contract variable key.
     * @param stage Requested stage.
     * @param input Candidate value.
     * @param source Stable source label.
     * @returns A validated prompt primitive.
     */
    private validateValue(key: string, stage: EnvStage, input: PromptInputValue, source: string): PromptValue {
        const rule = this.contract.variables[key]
        if (!rule) {
            throw new PromptEnvError({
                templateId: this.templateId,
                key,
                stage,
                source,
                reason: "undeclared-key",
            })
        }

        if (!rule.stages.includes(stage)) {
            throw new PromptEnvError({
                templateId: this.templateId,
                key,
                stage,
                source,
                reason: "disallowed-stage",
            })
        }

        if (typeof input !== "string" && typeof input !== "number" && typeof input !== "boolean") {
            throw new PromptEnvError({
                templateId: this.templateId,
                key,
                stage,
                source,
                reason: "invalid-value",
            })
        }

        return input
    }
}
