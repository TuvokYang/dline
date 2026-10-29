import type { DlineDefaultTool } from "../../../shared/tools"
import type { PromptProfile } from "../profiles/types"
import type { SystemPromptContext } from "../system-prompt/context"

export type ToolTransport = "native" | "xml" | "both"
export type ToolParamType = "string" | "boolean" | "integer" | "array" | "object"

/** Declarative prompt text enabled only when its runtime requirement matches. */
export interface ProfilePromptFragment {
    readonly text: string
    readonly contextRequirements?: (context: SystemPromptContext) => boolean
}

export interface ProfileToolParam {
    readonly name: string
    readonly required: boolean
    readonly instruction: string
    readonly type?: ToolParamType
    readonly enumValues?: readonly string[]
    readonly dependencies?: readonly DlineDefaultTool[]
    readonly contextRequirements?: (context: SystemPromptContext) => boolean
}

export interface ProfileToolSpec {
    readonly profile: PromptProfile
    readonly transport: ToolTransport
    readonly id: DlineDefaultTool
    readonly name: string
    readonly description: string
    readonly descriptionFragments?: readonly ProfilePromptFragment[]
    readonly instruction?: string
    readonly contextRequirements?: (context: SystemPromptContext) => boolean
    readonly parameters?: readonly ProfileToolParam[]
    readonly inputSchema?: object
}

/** Resolves declarative prompt fragments without mutating the canonical spec. */
export function resolveProfilePromptText(
    base: string,
    fragments: readonly ProfilePromptFragment[] | undefined,
    context: SystemPromptContext,
): string {
    let resolved = base
    for (const fragment of fragments ?? []) {
        if (fragment.contextRequirements && !fragment.contextRequirements(context)) continue
        resolved = resolved.replace(fragment.text, "")
    }
    return resolved
}

export type ProfileToolErrorReason = "missing-tool" | "duplicate-tool"

/** Reports exact profile tool registration and lookup failures. */
export class ProfileToolError extends Error {
    /** Creates a structured profile tool error. */
    public constructor(
        public readonly reason: ProfileToolErrorReason,
        public readonly profile: PromptProfile,
        public readonly toolId: DlineDefaultTool,
    ) {
        super(`Profile tool ${reason} profile=${profile} tool=${toolId}`)
        this.name = "ProfileToolError"
    }
}

/** Stores tool descriptors under exact Standard/Lite profile keys. */
export class ProfileToolSet {
    private readonly profiles = new Map<PromptProfile, Map<DlineDefaultTool, ProfileToolSpec>>()

    /** Registers one exact profile tool descriptor. */
    public register(spec: ProfileToolSpec): void {
        const tools = this.profiles.get(spec.profile) ?? new Map<DlineDefaultTool, ProfileToolSpec>()
        if (tools.has(spec.id)) {
            throw new ProfileToolError("duplicate-tool", spec.profile, spec.id)
        }
        tools.set(spec.id, spec)
        this.profiles.set(spec.profile, tools)
    }

    /** Resolves one tool without profile fallback. */
    public get(profile: PromptProfile, id: DlineDefaultTool): ProfileToolSpec {
        const spec = this.profiles.get(profile)?.get(id)
        if (!spec) {
            throw new ProfileToolError("missing-tool", profile, id)
        }
        return spec
    }

    /** Resolves an ordered exact-profile tool list. */
    public list(profile: PromptProfile, ids: readonly DlineDefaultTool[]): readonly ProfileToolSpec[] {
        return ids.map((id) => this.get(profile, id))
    }
}
