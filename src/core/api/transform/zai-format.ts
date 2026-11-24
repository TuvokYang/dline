import { toolParamNames } from "@core/assistant-message"
import { getToolUseNames } from "@shared/tools"
import { isGLMModelFamily } from "@/utils/model-utils"

/**
 * GLM writes a call as text tags; Dline parses tool-name tags instead.
 *
 * The format is fixed by the model's own chat template: the call tag names the
 * function, and every argument follows as a key/value tag pair.
 */
const CALL_OPEN = "<tool_call>"
const CALL_CLOSE = "</tool_call>"
const KEY_OPEN = "<arg_key>"
const KEY_CLOSE = "</arg_key>"
const VALUE_OPEN = "<arg_value>"
const VALUE_CLOSE = "</arg_value>"

export interface ZaiToolMarkupOptions {
    /**
     * Hold an unclosed call back instead of letting it reach the chat as prose.
     *
     * Only the streaming preview sets this: a call that has not closed yet is
     * still being written, so showing its tags would flash markup at the user.
     */
    readonly holdOpenCall?: boolean
}

export type ZaiToolMarkup = (text: string, options?: ZaiToolMarkupOptions) => string

/**
 * Create the reply-text normalizer for a ZAI model family member.
 *
 * A GLM model offered native tools can still answer with a call written as
 * text. An OpenAI-compatible gateway may pass that text through unchanged, so
 * the provider service receives it as ordinary content and never runs it. The
 * service already materializes tool markup written in prose; this normalizer
 * only restates the ZAI dialect in Dline's own markup, so that same path can
 * read it. It executes nothing and changes nothing for other model families.
 *
 * @param modelId Model id of the request that will produce the reply.
 * @returns A normalizer that leaves non-GLM models untouched.
 */
export function createZaiToolMarkup(modelId: string): ZaiToolMarkup {
    if (!isGLMModelFamily(modelId)) return (text) => text
    const knownTools: ReadonlySet<string> = new Set(getToolUseNames())
    const knownParams: ReadonlySet<string> = new Set(toolParamNames)
    return (text, options) => translate(text, knownTools, knownParams, options?.holdOpenCall === true)
}

function translate(
    text: string,
    knownTools: ReadonlySet<string>,
    knownParams: ReadonlySet<string>,
    holdOpenCall: boolean,
): string {
    let output = ""
    let cursor = 0
    for (;;) {
        const open = text.indexOf(CALL_OPEN, cursor)
        if (open === -1) return output + text.slice(cursor)
        const close = text.indexOf(CALL_CLOSE, open + CALL_OPEN.length)
        if (close === -1) {
            return output + (holdOpenCall ? text.slice(cursor, open) : text.slice(cursor))
        }
        output += text.slice(cursor, open)
        const translated = translateCall(text.slice(open + CALL_OPEN.length, close), knownTools, knownParams)
        output += translated ?? text.slice(open, close + CALL_CLOSE.length)
        cursor = close + CALL_CLOSE.length
    }
}

/**
 * Restate one call block in Dline markup.
 *
 * Returns undefined when the block cannot be restated exactly: an unknown
 * function or parameter, a missing closer, or a value that would end the
 * emitted parameter early. The caller then keeps the block as text, which is
 * the only safe outcome for a call it cannot read.
 */
function translateCall(inner: string, knownTools: ReadonlySet<string>, knownParams: ReadonlySet<string>): string | undefined {
    const firstKey = inner.indexOf(KEY_OPEN)
    const name = readTagValue(firstKey === -1 ? inner : inner.slice(0, firstKey))
    if (!knownTools.has(name)) return undefined

    const pairs: Array<[string, string]> = []
    let cursor = firstKey === -1 ? inner.length : firstKey
    while (cursor < inner.length) {
        const keyOpen = inner.indexOf(KEY_OPEN, cursor)
        if (keyOpen === -1) break
        const keyClose = inner.indexOf(KEY_CLOSE, keyOpen + KEY_OPEN.length)
        if (keyClose === -1) return undefined
        const key = readTagValue(inner.slice(keyOpen + KEY_OPEN.length, keyClose))
        if (!knownParams.has(key)) return undefined

        const valueOpen = skipSeparators(inner, keyClose + KEY_CLOSE.length)
        if (!inner.startsWith(VALUE_OPEN, valueOpen)) return undefined
        const valueStart = valueOpen + VALUE_OPEN.length
        const valueClose = inner.indexOf(VALUE_CLOSE, valueStart)
        if (valueClose === -1) return undefined
        const value = inner.slice(valueStart, valueClose)
        // The emitted parameter ends at this tag; a value carrying it would be
        // truncated by the parser, so the whole call stays text.
        if (value.includes(`</${key}>`)) return undefined

        pairs.push([key, value])
        cursor = valueClose + VALUE_CLOSE.length
    }
    if (inner.slice(skipSeparators(inner, cursor)).trim().length > 0) return undefined

    let markup = `<${name}>`
    for (const [key, value] of pairs) markup += `<${key}>${value}</${key}>`
    return `${markup}</${name}>`
}

/** Read a tag's text, tolerating the template's real or escaped line breaks. */
function readTagValue(raw: string): string {
    return raw
        .trim()
        .replace(/(?:\\[rn])+$/, "")
        .trim()
}

/** Skip whitespace and literal `\n` escapes the template may leave between tags. */
function skipSeparators(text: string, start: number): number {
    let index = start
    for (;;) {
        const char = text[index]
        if (char !== undefined && /\s/.test(char)) {
            index += 1
            continue
        }
        if (char === "\\" && text[index + 1] === "n") {
            index += 2
            continue
        }
        if (char === "\\" && text[index + 1] === "r" && text[index + 2] === "\\" && text[index + 3] === "n") {
            index += 4
            continue
        }
        return index
    }
}
