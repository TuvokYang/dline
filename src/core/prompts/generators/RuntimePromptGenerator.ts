import type { TemplateStore } from "../template/TemplateStore"
import type { PromptEnv, PromptOutput } from "../template/types"

/** Generates runtime feedback prompts through the immutable runtime environment stage. */
export class RuntimePromptGenerator {
    /**
     * Creates a runtime prompt generator over an injected static store.
     *
     * @param store Exact template store used for runtime generation.
     */
    public constructor(private readonly store: TemplateStore) {}

    /**
     * Generates one exact runtime template with declared environment values.
     *
     * @param templateId Stable module.key template identifier.
     * @param env Runtime environment values declared by the template contract.
     * @returns Rendered prompt output with warnings and trace data.
     */
    public generate(templateId: string, env: PromptEnv): PromptOutput {
        return this.store.load(templateId).env("runtime", env, "runtime-generator").generate()
    }
}
