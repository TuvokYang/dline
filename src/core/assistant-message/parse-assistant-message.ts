import { DlineDefaultTool, getToolUseNames } from "@shared/tools"
import { AssistantMessageContent, TextStreamContent, ToolParamName, ToolUse, toolParamNames } from "."

/**
 * Options for parse-time block identity assignment.
 */
// Summary text may quote the tool's XML example verbatim. Walk backward from
// the actual response tail so quoted closing payloads cannot become boundaries.
function findTerminalSummarizeContextClose(assistantMessage: string): number | undefined {
    const toolCloseTag = `</${DlineDefaultTool.SUMMARIZE_TASK}>`
    let tailStart = assistantMessage.trimEnd().length - toolCloseTag.length
    if (tailStart < 0 || !assistantMessage.startsWith(toolCloseTag, tailStart)) {
        return undefined
    }

    while (tailStart > 0 && /\s/.test(assistantMessage[tailStart - 1])) {
        tailStart--
    }

    const taskProgressCloseTag = "</task_progress>"
    const taskProgressCloseStart = tailStart - taskProgressCloseTag.length
    if (taskProgressCloseStart >= 0 && assistantMessage.startsWith(taskProgressCloseTag, taskProgressCloseStart)) {
        const taskProgressOpenTag = "<task_progress>"
        const taskProgressOpenStart = assistantMessage.lastIndexOf(taskProgressOpenTag, taskProgressCloseStart)
        if (taskProgressOpenStart < 0) {
            return undefined
        }
        tailStart = taskProgressOpenStart
        while (tailStart > 0 && /\s/.test(assistantMessage[tailStart - 1])) {
            tailStart--
        }
    }

    const contextCloseTag = "</context>"
    const contextCloseStart = tailStart - contextCloseTag.length
    return contextCloseStart >= 0 && assistantMessage.startsWith(contextCloseTag, contextCloseStart)
        ? contextCloseStart
        : undefined
}

export interface ParseTsRegistry {
    /**
     * Given a stable source-offset key, returns the ts for this block.
     * Keys are "text:<startOffset>" or "tool:<openTagStart>".
     * First call for a key creates the ts; subsequent calls return the same ts.
     */
    getOrCreateTsForBlock: (key: string) => number
    /** Allocate stable canonical identities for a non-native tool block. */
    getOrCreateToolIdentityForBlock: (key: string) => Pick<ToolUse, "function_id" | "dline_tid">
}

/**
 * Parses an assistant message string potentially containing mixed text and tool usage blocks
 * marked with XML-like tags into an array of structured content objects.
 *
 * Each block receives a stable `ts` assigned at parse time via the registry callback,
 * using source-offset keys that are stable across re-parses of the same growing text.
 *
 * @param assistantMessage The raw string output from the assistant.
 * @param registry Required ts registry for parse-time block identity assignment.
 *   Every caller must provide a registry; ephemeral ts generation is the caller's
 *   responsibility when needed (e.g. SubagentRunner creates its own counter).
 * @returns An array of `AssistantMessageContent` objects with ts assigned.
 */
export function parseAssistantMessage(assistantMessage: string, registry: ParseTsRegistry): AssistantMessageContent[] {
    const contentBlocks: AssistantMessageContent[] = []
    let currentTextContentStart = 0
    let currentTextContent: TextStreamContent | undefined
    let currentToolUseStart = 0
    let currentToolUse: ToolUse | undefined
    let currentParamValueStart = 0
    let currentParamName: ToolParamName | undefined

    const getTs = (key: string): number => {
        return registry.getOrCreateTsForBlock(key)
    }

    const toolUseOpenTags = new Map<string, string>()
    const toolParamOpenTags = new Map<string, ToolParamName>()
    for (const name of getToolUseNames()) {
        toolUseOpenTags.set(`<${name}>`, name)
    }
    for (const name of toolParamNames) {
        toolParamOpenTags.set(`<${name}>`, name)
    }

    const terminalSummarizeContextClose = findTerminalSummarizeContextClose(assistantMessage)
    const len = assistantMessage.length
    for (let i = 0; i < len; i++) {
        const currentCharIndex = i

        // --- State: Parsing a Tool Parameter ---
        if (currentToolUse && currentParamName) {
            const closeTag = `</${currentParamName}>`
            const closeTagStart = currentCharIndex - closeTag.length + 1
            const foundCloseTag = currentCharIndex >= closeTag.length - 1 && assistantMessage.startsWith(closeTag, closeTagStart)
            const foundTerminalParamClose =
                foundCloseTag &&
                (currentToolUse.name !== DlineDefaultTool.SUMMARIZE_TASK ||
                    currentParamName !== "context" ||
                    closeTagStart === terminalSummarizeContextClose)
            if (foundTerminalParamClose) {
                const value = assistantMessage.slice(currentParamValueStart, closeTagStart).trim()
                currentToolUse.params[currentParamName] = value
                currentParamName = undefined
            } else {
                continue
            }
        }

        // --- State: Parsing a Tool Use (but not a specific parameter) ---
        if (currentToolUse && !currentParamName) {
            let startedNewParam = false
            for (const [tag, paramName] of toolParamOpenTags.entries()) {
                if (currentCharIndex >= tag.length - 1 && assistantMessage.startsWith(tag, currentCharIndex - tag.length + 1)) {
                    currentParamName = paramName
                    currentParamValueStart = currentCharIndex + 1
                    startedNewParam = true
                    break
                }
            }
            if (startedNewParam) {
                continue
            }

            const toolCloseTag = `</${currentToolUse.name}>`
            if (
                currentCharIndex >= toolCloseTag.length - 1 &&
                assistantMessage.startsWith(toolCloseTag, currentCharIndex - toolCloseTag.length + 1)
            ) {
                const toolContentSlice = assistantMessage.slice(currentToolUseStart, currentCharIndex - toolCloseTag.length + 1)

                const contentParamName: ToolParamName = "content"
                if (currentToolUse.name === "write_to_file" && toolContentSlice.includes(`<${contentParamName}>`)) {
                    const contentStartTag = `<${contentParamName}>`
                    const contentEndTag = `</${contentParamName}>`
                    const contentStart = toolContentSlice.indexOf(contentStartTag)
                    const contentEnd = toolContentSlice.lastIndexOf(contentEndTag)

                    if (contentStart !== -1 && contentEnd !== -1 && contentEnd > contentStart) {
                        const contentValue = toolContentSlice.slice(contentStart + contentStartTag.length, contentEnd).trim()
                        currentToolUse.params[contentParamName] = contentValue
                    }
                }

                currentToolUse.partial = false
                contentBlocks.push(currentToolUse)
                currentToolUse = undefined
                currentTextContentStart = currentCharIndex + 1
                continue
            }
            continue
        }

        // --- State: Parsing Text / Looking for Tool Start ---
        if (!currentToolUse) {
            let startedNewTool = false
            for (const [tag, toolName] of toolUseOpenTags.entries()) {
                if (currentCharIndex >= tag.length - 1 && assistantMessage.startsWith(tag, currentCharIndex - tag.length + 1)) {
                    // toolOpenTagStart = position where '<' of opening tag begins
                    const toolOpenTagStart = currentCharIndex - tag.length + 1

                    if (currentTextContent) {
                        currentTextContent.content = assistantMessage.slice(currentTextContentStart, toolOpenTagStart).trim()
                        currentTextContent.partial = false
                        if (currentTextContent.content.length > 0) {
                            contentBlocks.push(currentTextContent)
                        }
                        currentTextContent = undefined
                    } else {
                        const potentialText = assistantMessage.slice(currentTextContentStart, toolOpenTagStart).trim()
                        if (potentialText.length > 0) {
                            contentBlocks.push({
                                type: "text",
                                content: potentialText,
                                partial: false,
                                ts: getTs(`text:${currentTextContentStart}`),
                            })
                        }
                    }

                    const identity = registry.getOrCreateToolIdentityForBlock(`tool:${toolOpenTagStart}`)
                    currentToolUse = {
                        type: "tool_use",
                        name: toolName as DlineDefaultTool,
                        params: {},
                        partial: true,
                        ts: getTs(`tool:${toolOpenTagStart}`),
                        ...identity,
                        isNativeToolCall: false,
                    }
                    currentToolUseStart = currentCharIndex + 1
                    startedNewTool = true
                    break
                }
            }

            if (startedNewTool) {
                continue
            }

            if (!currentTextContent) {
                currentTextContentStart = currentCharIndex
                currentTextContent = {
                    type: "text",
                    content: "",
                    partial: true,
                    ts: getTs(`text:${currentTextContentStart}`),
                }
            }
        }
    }

    // --- Finalization after loop ---
    if (currentToolUse && currentParamName) {
        if (currentParamName !== "path" && currentParamName !== "absolutePath") {
            currentToolUse.params[currentParamName] = assistantMessage.slice(currentParamValueStart).trim()
        }
    }

    if (currentToolUse) {
        contentBlocks.push(currentToolUse)
    } else if (currentTextContent) {
        currentTextContent.content = assistantMessage.slice(currentTextContentStart).trim()
        if (currentTextContent.content.length > 0) {
            contentBlocks.push(currentTextContent)
        }
    }

    return contentBlocks
}
