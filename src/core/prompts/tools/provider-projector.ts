import type { Tool as AnthropicTool } from "@anthropic-ai/sdk/resources/index"
import { type FunctionDeclaration as GoogleTool, Type as GoogleType } from "@google/genai"
import type {
	ChatCompletionFunctionTool as OpenAIFunctionTool,
	ChatCompletionTool as OpenAITool,
} from "openai/resources/chat/completions"
import type { ClineDefaultTool, ClineTool } from "../../../shared/tools"
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
	enabledToolIds: ReadonlySet<ClineDefaultTool>,
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
	enabledToolIds: ReadonlySet<ClineDefaultTool>,
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
	enabledToolIds: ReadonlySet<ClineDefaultTool>,
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
	enabledToolIds: ReadonlySet<ClineDefaultTool>,
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
	enabledToolIds: ReadonlySet<ClineDefaultTool>,
): GoogleTool {
	const parameters = toGoogleSchema(buildSchema(spec, context, enabledToolIds)) as NonNullable<GoogleTool["parameters"]>
	return {
		name: spec.name,
		description: resolveProfilePromptText(spec.description, spec.descriptionFragments, context),
		parameters,
	}
}

/**
 * Providers that post to the Anthropic Messages API.
 *
 * The projection follows the wire protocol, not the vendor: that API validates
 * each tool by its `type` tag and rejects the OpenAI function wrapper, so any
 * provider speaking it needs the input-schema shape regardless of how its
 * credentials or catalog are obtained.
 */
const ANTHROPIC_PROTOCOL_PROVIDERS: ReadonlySet<string> = new Set(["anthropic", "claude-code", "bedrock", "minimax"])

/** Projects one canonical profile spec to the active provider schema. */
export function projectTool(
	spec: ProfileToolSpec,
	context: SystemPromptContext,
	enabledToolIds: ReadonlySet<ClineDefaultTool>,
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
