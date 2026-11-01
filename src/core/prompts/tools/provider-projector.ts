import type { Tool as AnthropicTool } from "@anthropic-ai/sdk/resources/index"
import { type FunctionDeclaration as GoogleTool, Type as GoogleType } from "@google/genai"
import { ApiFormat } from "@shared/proto/dline/models/metadata"
import type {
    ChatCompletionFunctionTool as OpenAIFunctionTool,
    ChatCompletionTool as OpenAITool,
} from "openai/resources/chat/completions"
import type { ClineTool, DlineDefaultTool } from "../../../shared/tools"
import type { SystemPromptContext } from "../system-prompt/context"
import { type ProfileToolParam, type ProfileToolSpec, resolveProfilePromptText, type ToolParamType } from "./profile-tool-set"

type JsonSchemaValue = string | number | boolean | null | readonly JsonSchemaValue[] | JsonSchemaObject

interface JsonSchemaObject {
    readonly [key: string]: JsonSchemaValue
}

const GOOGLE_TYPES: Readonly<Record<ToolParamType, GoogleType>> = {
    string: GoogleType.STRING,
    boolean: GoogleType.BOOLEAN,
    integer: GoogleType.NUMBER,
    array: GoogleType.ARRAY,
    object: GoogleType.OBJECT,
}

/** Filters runtime-disabled parameters without mutating canonical specs. */
function enabledParams(
    spec: ProfileToolSpec,
    context: SystemPromptContext,
    enabledToolIds: ReadonlySet<DlineDefaultTool>,
): readonly ProfileToolParam[] {
    return (spec.parameters ?? []).filter((parameter) => {
        if (parameter.dependencies && parameter.dependencies.some((dependency) => !enabledToolIds.has(dependency))) {
            return false
        }
        return !parameter.contextRequirements || parameter.contextRequirements(context)
    })
}

/** Builds a provider-neutral JSON schema for built-in descriptors. */
function buildSchema(
    spec: ProfileToolSpec,
    context: SystemPromptContext,
    enabledToolIds: ReadonlySet<DlineDefaultTool>,
): JsonSchemaObject {
    if (spec.inputSchema) {
        return spec.inputSchema as JsonSchemaObject
    }
    const properties: Record<string, JsonSchemaObject> = {}
    const required: string[] = []
    for (const parameter of enabledParams(spec, context, enabledToolIds)) {
        properties[parameter.name] = {
            type: parameter.type ?? "string",
            description: parameter.instruction,
            ...(parameter.enumValues ? { enum: parameter.enumValues } : {}),
        }
        if (parameter.required) required.push(parameter.name)
    }
    return { type: "object", properties, required, additionalProperties: false }
}

/** Creates an OpenAI-compatible function tool. */
function toOpenAI(
    spec: ProfileToolSpec,
    context: SystemPromptContext,
    enabledToolIds: ReadonlySet<DlineDefaultTool>,
): OpenAITool {
    const parameters = buildSchema(spec, context, enabledToolIds) as NonNullable<OpenAIFunctionTool["function"]["parameters"]>
    return {
        type: "function",
        function: {
            name: spec.name,
            description: resolveProfilePromptText(spec.description, spec.descriptionFragments, context),
            strict: false,
            parameters,
        },
    }
}

/** Creates an Anthropic input-schema tool. */
function toAnthropic(
    spec: ProfileToolSpec,
    context: SystemPromptContext,
    enabledToolIds: ReadonlySet<DlineDefaultTool>,
): AnthropicTool {
    const inputSchema = buildSchema(spec, context, enabledToolIds) as AnthropicTool["input_schema"]
    return {
        name: spec.name,
        description: resolveProfilePromptText(spec.description, spec.descriptionFragments, context),
        input_schema: inputSchema,
    }
}

/** Recursively converts JSON Schema type strings to Gemini schema enums. */
function toGoogleSchema(value: JsonSchemaValue): JsonSchemaValue {
    if (Array.isArray(value)) {
        return value.map(toGoogleSchema)
    }
    if (value !== null && typeof value === "object") {
        const converted: Record<string, JsonSchemaValue> = {}
        for (const [key, child] of Object.entries(value)) {
            if (key === "type" && typeof child === "string") {
                converted[key] = GOOGLE_TYPES[child as ToolParamType] ?? child
            } else {
                converted[key] = toGoogleSchema(child)
            }
        }
        return converted
    }
    return value
}

/** Creates a Gemini function declaration. */
function toGoogle(
    spec: ProfileToolSpec,
    context: SystemPromptContext,
    enabledToolIds: ReadonlySet<DlineDefaultTool>,
): GoogleTool {
    const parameters = toGoogleSchema(buildSchema(spec, context, enabledToolIds)) as NonNullable<GoogleTool["parameters"]>
    return {
        name: spec.name,
        description: resolveProfilePromptText(spec.description, spec.descriptionFragments, context),
        parameters,
    }
}

/**
 * Providers whose wire protocol is the Anthropic Messages API.
 *
 * This set exists only for requests that carry no protocol fact. It is the
 * pre-existing behaviour, kept so that a context built without a selected format
 * projects exactly what it projected before the format-first path existed.
 */
const ANTHROPIC_PROTOCOL_PROVIDERS: ReadonlySet<string> = new Set(["anthropic", "claude-code", "bedrock", "minimax"])

/**
 * Projects one canonical profile spec to the schema of the wire protocol.
 *
 * The transport validates tool schemas, not the vendor: an Anthropic Messages
 * endpoint rejects the OpenAI function wrapper whatever provider name is
 * configured, and an OpenAI-compatible endpoint rejects `input_schema`. The
 * request-level format therefore decides the shape whenever it is known, and the
 * provider identity is only a fallback for contexts built without one.
 *
 * @param spec Canonical tool descriptor.
 * @param context Prompt context, optionally carrying the request's API format.
 * @param enabledToolIds Tools enabled for this task.
 * @returns The tool in the shape the active protocol accepts.
 */
export function projectTool(
    spec: ProfileToolSpec,
    context: SystemPromptContext,
    enabledToolIds: ReadonlySet<DlineDefaultTool>,
): ClineTool {
    if (context.selectedApiFormat !== undefined) {
        const projected = projectByApiFormat(spec, context, enabledToolIds, context.selectedApiFormat)
        if (projected) return projected
    }
    return projectByProviderId(spec, context, enabledToolIds)
}

/**
 * Project by the protocol the request will be sent with.
 *
 * Returns `undefined` for a format this build does not know, so the caller falls
 * back to the provider identity instead of guessing a wrapper. A newer format
 * reaching an older projection must not silently become the OpenAI shape.
 */
function projectByApiFormat(
    spec: ProfileToolSpec,
    context: SystemPromptContext,
    enabledToolIds: ReadonlySet<DlineDefaultTool>,
    apiFormat: ApiFormat,
): ClineTool | undefined {
    switch (apiFormat) {
        case ApiFormat.ANTHROPIC_CHAT:
            return toAnthropic(spec, context, enabledToolIds)
        case ApiFormat.GEMINI_CHAT:
            return toGoogle(spec, context, enabledToolIds)
        case ApiFormat.OPENAI_CHAT:
        case ApiFormat.OPENAI_RESPONSES:
        case ApiFormat.OPENAI_RESPONSES_WEBSOCKET_MODE:
        case ApiFormat.R1_CHAT:
            return toOpenAI(spec, context, enabledToolIds)
        default:
            return undefined
    }
}

/** Project by provider identity, for contexts that carry no protocol fact. */
function projectByProviderId(
    spec: ProfileToolSpec,
    context: SystemPromptContext,
    enabledToolIds: ReadonlySet<DlineDefaultTool>,
): ClineTool {
    const providerId = context.providerInfo.providerId
    if (ANTHROPIC_PROTOCOL_PROVIDERS.has(providerId)) {
        return toAnthropic(spec, context, enabledToolIds)
    }
    if (providerId === "gemini" || (providerId === "vertex" && context.providerInfo.model.id.includes("gemini"))) {
        return toGoogle(spec, context, enabledToolIds)
    }
    return toOpenAI(spec, context, enabledToolIds)
}
