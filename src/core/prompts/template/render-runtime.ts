import type { PromptEnv, PromptOutput } from "./types"

/** Rejects legacy runtime-created contracts; callers must use statically declared template contracts. */
export function renderRuntime(_templateId: string, _template: string, _env: PromptEnv): PromptOutput {
    throw new Error("renderRuntime is disabled: use a statically registered PromptTemplate contract")
}
