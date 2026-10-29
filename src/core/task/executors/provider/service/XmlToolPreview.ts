import { parseAssistantMessage, type ToolUse } from "@core/assistant-message"
import type { ParseTsRegistry } from "@core/assistant-message/parse-assistant-message"
import { DlineDefaultTool, getToolUseNames } from "@shared/tools"
import { isExplicitOnlyTool } from "../../../explicit-instructions/policy"

type AssistantBlocks = ReturnType<typeof parseAssistantMessage>
type ToolIdentity = Pick<ToolUse, "function_id" | "dline_tid">

/** A call the preview draws has no canonical identity yet; only the final parse names it. */
const PREVIEW_IDENTITY: ToolIdentity = { function_id: "", dline_tid: "" }

/** The parser keys a tool block by where its opening tag starts. */
const TOOL_BLOCK_KEY_PREFIX = "tool:"

/** The text blocks of a parsed reply, joined as one prose row. */
export function proseOf(blocks: AssistantBlocks): string {
    let prose = ""
    let hasText = false
    for (const block of blocks) {
        if (block.type !== "text") continue
        if (hasText) prose += "\n\n"
        prose += block.content
        hasText = true
    }
    return prose
}

/**
 * The prose of an assistant reply with its tool markup removed.
 *
 * Tool markup is an invocation, not something the model said to the user: a
 * call the task refuses (an explicit-only tool nobody authorized) must not
 * reach the chat as text while it streams any more than after it settles.
 */
export function assistantProse(text: string): string {
    return proseOf(parsePreview(text).blocks)
}

/**
 * The prose of a reply that is still streaming: tool markup removed, and a
 * trailing tag that may still open a call held back until it settles.
 */
export function streamingProse(text: string): string {
    const { blocks } = parsePreview(text)
    return withoutOpeningTagPrefix(proseOf(blocks), text, blocks)
}

/** The reply so far as the chat shows it while it streams. */
export interface XmlPreviewFrame {
    /** Prose without tool markup, holding back a trailing tag that may still open a call. */
    readonly prose: string
    /**
     * The tool cards whose content changed since the previous frame.
     *
     * Read only once the prose was shown: a card draws its row id here, and a
     * row drawn before the prose row would sort above the text that led to it.
     */
    cards(): ToolUse[]
}

/**
 * Previews the tool calls a reply writes as markup while it streams.
 *
 * Each frame is parsed with the parser and source-offset keys the final parse
 * uses, so a call keeps one chat row from its opening tag to its settlement:
 * the row id is drawn once per opening tag, and the final parse reads it back
 * through `registry`. Canonical call identities are drawn by the final parse
 * only, so a call that never settles never consumes one.
 *
 * The preview only presents. A card appears once its opening tag is complete
 * and is never turned back into prose: a call that never closes, or that the
 * final parse does not materialize, keeps a row nobody settles, which the
 * presenter withdraws when the turn ends.
 */
export class XmlToolPreview {
    private readonly rows = new Map<string, number>()
    /** The content each card last showed, so a chunk that changed nothing is not redrawn. */
    private readonly drawn = new Map<string, string>()

    constructor(private readonly nextPresentationId: () => number) {}

    /** Read the whole reply so far. */
    read(text: string): XmlPreviewFrame {
        const { blocks, toolKeys } = parsePreview(text)
        const tools = blocks.filter((block): block is ToolUse => block.type === "tool_use")
        return {
            prose: withoutOpeningTagPrefix(proseOf(blocks), text, blocks),
            cards: () => this.changedCards(tools, toolKeys),
        }
    }

    /** The registry of the final parse: a settled call keeps the row its preview drew. */
    registry(identityFor: (key: string) => ToolIdentity): ParseTsRegistry {
        return {
            getOrCreateTsForBlock: (key) => this.rowFor(key),
            getOrCreateToolIdentityForBlock: identityFor,
        }
    }

    private changedCards(tools: readonly ToolUse[], keys: readonly string[]): ToolUse[] {
        const cards: ToolUse[] = []
        tools.forEach((block, index) => {
            const key = keys[index]
            if (key === undefined || !mayPreviewToolCall(block.name)) return
            const content = JSON.stringify([block.name, block.params])
            if (this.drawn.get(key) === content) return
            this.drawn.set(key, content)
            cards.push({ ...block, ts: this.rowFor(key), partial: true })
        })
        return cards
    }

    private rowFor(key: string): number {
        const existing = this.rows.get(key)
        if (existing !== undefined) return existing
        const created = this.nextPresentationId()
        this.rows.set(key, created)
        return created
    }
}

/** Parse without drawing identities, collecting the key of each tool block in order. */
function parsePreview(text: string): { blocks: AssistantBlocks; toolKeys: string[] } {
    const toolKeys: string[] = []
    const blocks = parseAssistantMessage(text, {
        // Asked once per block as it opens, so the keys line up with the tool blocks.
        getOrCreateTsForBlock: (key) => {
            if (key.startsWith(TOOL_BLOCK_KEY_PREFIX)) toolKeys.push(key)
            return 0
        },
        getOrCreateToolIdentityForBlock: () => PREVIEW_IDENTITY,
    })
    return { blocks, toolKeys }
}

/**
 * Whether a call may be drawn before it settles, written as markup or natively.
 *
 * Only the tool gate knows whether the turn may call an explicit-only tool, and
 * it decides when the call settles; drawing one sooner would show the content
 * of a call the task may refuse.
 */
export function mayPreviewToolCall(tool: string): boolean {
    return tool !== DlineDefaultTool.CONDENSE && !isExplicitOnlyTool(tool as DlineDefaultTool)
}

/**
 * Hold back a trailing `<…` that may still grow into a tool's opening tag.
 *
 * Shown as prose it would vanish a chunk later, once the tag completes and the
 * parser reads it as a call. As soon as it can no longer open one it is prose,
 * and the next frame shows it.
 */
function withoutOpeningTagPrefix(prose: string, text: string, blocks: AssistantBlocks): string {
    if (blocks[blocks.length - 1]?.type !== "text") return prose
    const start = text.lastIndexOf("<")
    if (start < 0) return prose
    const tail = text.slice(start)
    if (!prose.endsWith(tail) || !mayOpenToolTag(tail)) return prose
    return prose.slice(0, prose.length - tail.length).trimEnd()
}

function mayOpenToolTag(tail: string): boolean {
    return getToolUseNames().some((name) => {
        const tag = `<${name}>`
        return tag.length > tail.length && tag.startsWith(tail)
    })
}
