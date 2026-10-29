export type PromptValue = string | number | boolean
export type PromptInputValue = PromptValue | object | null | undefined
export type PromptEnv = Readonly<Record<string, PromptValue>>
export type PromptEnvInput = Readonly<Record<string, PromptInputValue>>
export type EnvStage = "base" | "variant" | "runtime"

export interface EnvTrace {
    readonly key: string
    readonly stage: EnvStage
    readonly source: string
    readonly replacedSource?: string
}

export interface EnvRule {
    readonly stages: readonly EnvStage[]
    readonly required: boolean
}

export interface PromptContract {
    readonly variables: Readonly<Record<string, EnvRule>>
}

export interface PromptWarning {
    readonly templateId: string
    readonly key: string
    readonly rule: EnvRule | undefined
    readonly loadedStages: readonly EnvStage[]
    readonly trace: readonly EnvTrace[]
}

export interface PromptOutput {
    readonly text: string
    readonly warnings: readonly PromptWarning[]
    readonly trace: readonly EnvTrace[]
}
