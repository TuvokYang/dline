import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"
import { Logger } from "@/shared/services/Logger"

export function convertToO1Messages(
    openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[],
    systemPrompt: string,
): OpenAI.Chat.ChatCompletionMessageParam[] {
    const toolsReplaced = openAiMessages.reduce((acc, message) => {
        if (message.role === "tool") {
            // Convert tool messages to user messages
            acc.push({
                role: "user",
                content: message.content || "",
            })
        } else if (message.role === "assistant" && message.tool_calls) {
            // Convert tool calls to content and remove tool_calls
            let content = message.content || ""
            message.tool_calls.forEach((toolCall) => {
                if (toolCall.type === "function") {
                    content += `\nTool Call: ${toolCall.function.name}\nArguments: ${toolCall.function.arguments}`
                }
            })
            acc.push({
                role: "assistant",
                content: content,
            })
        } else {
            // Keep other messages as they are
            acc.push(message)
        }
        return acc
    }, [] as OpenAI.Chat.ChatCompletionMessageParam[])

    // Find the index of the last assistant message
    // const lastAssistantIndex = findLastIndex(toolsReplaced, (message) => message.role === "assistant")

    // Create a new array to hold the modified messages
    const messagesWithSystemPrompt = [
        {
            role: "user",
            content: systemPrompt,
        } as OpenAI.Chat.ChatCompletionUserMessageParam,
        ...toolsReplaced,
    ]

    // If there's an assistant message, insert the system prompt after it
    // if (lastAssistantIndex !== -1) {
    // 	const insertIndex = lastAssistantIndex + 1
    // 	if (insertIndex < messagesWithSystemPrompt.length && messagesWithSystemPrompt[insertIndex].role === "user") {
    // 		messagesWithSystemPrompt.splice(insertIndex, 0, {
    // 			role: "user",
    // 			content: systemPrompt,
    // 		})
    // 	}
    // } else {
    // 	// If there were no assistant messages, prepend the system prompt
    // 	messagesWithSystemPrompt.unshift({
    // 		role: "user",
    // 		content: systemPrompt,
    // 	})
    // }

    return messagesWithSystemPrompt
}

interface ToolCall {
    tool: string
    tool_input: Record<string, string>
}

const toolNames = [
    "execute_command",
    "list_files",
    "list_code_definition_names",
    "search_files",
    "read_file",
    "write_to_file",
    "ask_followup_question",
    "attempt_completion",
]

function parseAIResponse(response: string): {
    normalText: string
    toolCalls: ToolCall[]
} {
    // Create a regex pattern to match any tool call opening tag
    const toolCallPattern = new RegExp(`<(${toolNames.join("|")})`, "i")
    const match = response.match(toolCallPattern)

    if (!match) {
        // No tool calls found
        return { normalText: response.trim(), toolCalls: [] }
    }

    const toolCallStart = match.index!
    const normalText = response.slice(0, toolCallStart).trim()
    const toolCallsText = response.slice(toolCallStart)

    const toolCalls = parseToolCalls(toolCallsText)

    return { normalText, toolCalls }
}

function parseToolCalls(toolCallsText: string): ToolCall[] {
    const toolCalls: ToolCall[] = []

    let remainingText = toolCallsText

    while (remainingText.length > 0) {
        const toolMatch = toolNames.find((tool) => new RegExp(`<${tool}`, "i").test(remainingText))

        if (!toolMatch) {
            break // No more tool calls found
        }

        const startTag = `<${toolMatch}`
        const endTag = `</${toolMatch}>`
        const startIndex = remainingText.indexOf(startTag)
        const endIndex = remainingText.indexOf(endTag, startIndex)

        if (endIndex === -1) {
            break // Malformed XML, no closing tag found
        }

        const toolCallContent = remainingText.slice(startIndex, endIndex + endTag.length)
        remainingText = remainingText.slice(endIndex + endTag.length).trim()

        const toolCall = parseToolCall(toolMatch, toolCallContent)
        if (toolCall) {
            toolCalls.push(toolCall)
        }
    }

    return toolCalls
}

function parseToolCall(toolName: string, content: string): ToolCall | null {
    const tool_input: Record<string, string> = {}

    // Remove the outer tool tags
    const innerContent = content.replace(new RegExp(`^<${toolName}>|</${toolName}>$`, "g"), "").trim()

    // Parse nested XML elements
    const paramRegex = /<(\w+)>([\s\S]*?)<\/\1>/gs
    let match: RegExpExecArray | null

    while ((match = paramRegex.exec(innerContent)) !== null) {
        const [, paramName, paramValue] = match
        // Preserve newlines and trim only leading/trailing whitespace
        tool_input[paramName] = paramValue.replace(/^\s+|\s+$/g, "")
    }

    // Validate required parameters
    if (!validateToolInput(toolName, tool_input)) {
        Logger.error(`Invalid tool call for ${toolName}:`, content)
        return null
    }

    return { tool: toolName, tool_input }
}

function validateToolInput(toolName: string, tool_input: Record<string, string>): boolean {
    switch (toolName) {
        case "execute_command":
            return "command" in tool_input
        case "read_file":
        case "list_code_definition_names":
        case "list_files":
            return "path" in tool_input
        case "search_files":
            return "path" in tool_input && "regex" in tool_input
        case "write_to_file":
            return "path" in tool_input && "content" in tool_input
        case "ask_followup_question":
            return "question" in tool_input
        case "attempt_completion":
            return "result" in tool_input
        default:
            return false
    }
}

// Example usage:
// const aiResponse = `Here's my analysis of the situation...

// <execute_command>
//   <command>ls -la</command>
// </execute_command>

// <write_to_file>
//   <path>./example.txt</path>
//   <content>Hello, World!</content>
// </write_to_file>`;
//
// const { normalText, toolCalls } = parseAIResponse(aiResponse);
// Logger.log(normalText);
// Logger.log(toolCalls);

// Convert OpenAI response to Anthropic format
export function convertO1ResponseToAnthropicMessage(
    completion: OpenAI.Chat.Completions.ChatCompletion,
): Anthropic.Messages.Message {
    const openAiMessage = completion.choices[0].message
    const { normalText, toolCalls } = parseAIResponse(openAiMessage.content || "")

    const anthropicMessage: Anthropic.Messages.Message = {
        id: completion.id,
        type: "message",
        role: openAiMessage.role, // always "assistant"
        container: null,
        content: [
            {
                type: "text",
                text: normalText,
                citations: null,
            },
        ],
        model: completion.model,
        stop_details: null,
        stop_reason: (() => {
            switch (completion.choices[0].finish_reason) {
                case "stop":
                    return "end_turn"
                case "length":
                    return "max_tokens"
                case "tool_calls":
                    return "tool_use"
                default:
                    return null
            }
        })(),
        stop_sequence: null, // which custom stop_sequence was generated, if any (not applicable if you don't use stop_sequence)
        usage: {
            input_tokens: completion.usage?.prompt_tokens || 0,
            output_tokens: completion.usage?.completion_tokens || 0,
            cache_creation: null,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
            inference_geo: null,
            output_tokens_details: null,
            server_tool_use: null,
            service_tier: null,
        },
    }

    if (toolCalls.length > 0) {
        anthropicMessage.content.push(
            ...toolCalls.map((toolCall: ToolCall, index: number): Anthropic.ToolUseBlock => {
                return {
                    type: "tool_use",
                    id: `call_${index}_${Date.now()}`, // Generate a unique ID for each tool call
                    caller: { type: "direct" },
                    name: toolCall.tool,
                    input: toolCall.tool_input,
                }
            }),
        )
    }

    return anthropicMessage
}

// Example usage:
// const openAICompletion = {
//     id: "cmpl-123",
//     choices: [{
//         message: {
//             role: "assistant",
//             content: "Here's my analysis...\n\n<execute_command>\n  <command>ls -la</command>\n</execute_command>"
//         },
//         finish_reason: "stop"
//     }],
//     model: "gpt-3.5-turbo",
//     usage: { prompt_tokens: 50, completion_tokens: 100 }
// };
// const anthropicMessage = convertO1ResponseToAnthropicMessage(openAICompletion);
// Logger.log(anthropicMessage);
