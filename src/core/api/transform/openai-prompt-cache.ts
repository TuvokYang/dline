import type OpenAI from "openai"
import { hashPromptContentHex } from "@/core/prompts/system-prompt-cache/hash"

const EXPLICIT_BREAKPOINT = { mode: "explicit" as const }
const PROMPT_CACHE_KEY_PREFIX = "dline_cache_"
const PROMPT_CACHE_KEY_IDENTIFIER_LENGTH = 32

export type OpenAIPromptCacheProjectionMode = "automatic" | "explicit"

interface PromptCacheIdentityInput {
    readonly modelId: string
    readonly systemPrompt: string
    readonly taskNamespace?: string
    readonly tools: readonly unknown[]
}

export interface OpenAIChatPromptCacheInput {
    readonly modelId: string
    readonly systemPrompt: string
    readonly messages: OpenAI.Chat.ChatCompletionMessageParam[]
    readonly tools: readonly OpenAI.Chat.ChatCompletionTool[]
    readonly taskNamespace?: string
    readonly mode?: OpenAIPromptCacheProjectionMode
}

export interface OpenAIChatPromptCacheProjection {
    readonly messages: OpenAI.Chat.ChatCompletionMessageParam[]
    readonly promptCacheKey: string
    readonly promptCacheOptions?: OpenAI.Chat.ChatCompletionCreateParams.PromptCacheOptions
}

export interface OpenAIResponsesPromptCacheInput {
    readonly modelId: string
    readonly systemPrompt: string
    readonly input: OpenAI.Responses.ResponseInput
    readonly tools: readonly OpenAI.Responses.Tool[]
    readonly taskNamespace?: string
    readonly mode?: OpenAIPromptCacheProjectionMode
}

export interface OpenAIResponsesPromptCacheProjection {
    readonly instructions?: string
    readonly input: OpenAI.Responses.ResponseInput
    readonly promptCacheKey: string
    readonly promptCacheOptions?: OpenAI.Responses.ResponseCreateParams.PromptCacheOptions
}

interface MutableContentMessage {
    readonly role?: unknown
    content?: unknown
    readonly [key: string]: unknown
}

interface MutableContentBlock {
    readonly type?: unknown
    readonly [key: string]: unknown
}

/** Build a non-sensitive, namespaced routing key from the stable rendered-prefix inputs. */
function createPromptCacheKey(input: PromptCacheIdentityInput): string {
    const identifier = hashPromptContentHex(
        JSON.stringify({
            model: input.modelId,
            systemPrompt: input.systemPrompt,
            taskNamespace: input.taskNamespace,
            tools: input.tools,
        }),
    ).slice(0, PROMPT_CACHE_KEY_IDENTIFIER_LENGTH)
    return `${PROMPT_CACHE_KEY_PREFIX}${identifier}`
}

function addBreakpointToChatMessage(
    message: OpenAI.Chat.ChatCompletionMessageParam,
): OpenAI.Chat.ChatCompletionMessageParam | undefined {
    const projected = { ...message } as unknown as MutableContentMessage
    if (typeof projected.content === "string") {
        projected.content = [
            {
                type: "text",
                text: projected.content,
                prompt_cache_breakpoint: EXPLICIT_BREAKPOINT,
            },
        ]
        return projected as unknown as OpenAI.Chat.ChatCompletionMessageParam
    }
    if (!Array.isArray(projected.content)) return undefined

    const content = [...projected.content]
    for (let index = content.length - 1; index >= 0; index--) {
        const block = content[index]
        if (typeof block !== "object" || block === null) continue
        const typedBlock = block as MutableContentBlock
        if (typedBlock.type !== "text") continue

        content[index] = { ...typedBlock, prompt_cache_breakpoint: EXPLICIT_BREAKPOINT }
        projected.content = content
        return projected as unknown as OpenAI.Chat.ChatCompletionMessageParam
    }
    return undefined
}

function addChatBreakpoints(messages: OpenAI.Chat.ChatCompletionMessageParam[]): OpenAI.Chat.ChatCompletionMessageParam[] {
    const projected = [...messages]

    // The explicit breakpoint marks the end of the reusable stable prefix.
    // It must live on the system/developer message only: placing it on dynamic
    // tail messages (user input, environment details, tool history) would pull
    // changing content into the cached prefix and drop every cache hit.
    const first = projected[0]
    if (first?.role === "system" || first?.role === "developer") {
        const marked = addBreakpointToChatMessage(first)
        if (marked) {
            projected[0] = marked
        }
    }

    return projected
}

/** Project official prompt-cache controls onto a Chat Completions request. */
export function projectOpenAIChatPromptCache(input: OpenAIChatPromptCacheInput): OpenAIChatPromptCacheProjection {
    const promptCacheKey = createPromptCacheKey({
        modelId: input.modelId,
        systemPrompt: input.systemPrompt,
        taskNamespace: input.taskNamespace,
        tools: input.tools,
    })
    if (input.mode !== "explicit") {
        return { messages: input.messages, promptCacheKey }
    }

    return {
        messages: addChatBreakpoints(input.messages),
        promptCacheKey,
        promptCacheOptions: { mode: "explicit" },
    }
}

/** Project official prompt-cache controls onto a Responses request. */
export function projectOpenAIResponsesPromptCache(input: OpenAIResponsesPromptCacheInput): OpenAIResponsesPromptCacheProjection {
    const promptCacheKey = createPromptCacheKey({
        modelId: input.modelId,
        systemPrompt: input.systemPrompt,
        taskNamespace: input.taskNamespace,
        tools: input.tools,
    })
    if (input.mode !== "explicit") {
        return {
            instructions: input.systemPrompt,
            input: input.input,
            promptCacheKey,
        }
    }

    const developerMessage: OpenAI.Responses.EasyInputMessage = {
        type: "message",
        role: "developer",
        content: [
            {
                type: "input_text",
                text: input.systemPrompt,
                prompt_cache_breakpoint: EXPLICIT_BREAKPOINT,
            },
        ],
    }
    return {
        input: [developerMessage, ...input.input],
        promptCacheKey,
        promptCacheOptions: { mode: "explicit" },
    }
}
