import type { ClineToolResponseContent, ClineUserContent, ClineUserToolResultContentBlock } from "@shared/messages"

export const DURABLE_TOOL_RESULT_VERSION = 1 as const

/**
 * How a result returns to the provider when its call was never recorded as a
 * tool call in the conversation.
 *
 * A call the model wrote as markup beside native tools stays markup in the
 * history, so there is no provider call its result could pair with. Replaying
 * a paired result there would invent a call id the provider never issued.
 */
export interface DurableToolResultTextReplay {
    readonly kind: "text"
    readonly toolName: string
    /**
     * Whether the content already opens with the call's own `Result:` header.
     * Absent on rows written before results carried it, which get the header
     * from the tool name when replayed.
     */
    readonly described?: boolean
}

interface PersistedTextReplay {
    kind: "text"
    tool_name: string
    described?: true
}

interface DurableToolResultV1 {
    version: typeof DURABLE_TOOL_RESULT_VERSION
    function_id: string
    dline_tid: string
    content: ClineToolResponseContent
    is_error: boolean | null
    /** Absent for every result paired with a recorded call, including all rows written before it existed. */
    replay?: PersistedTextReplay
}

interface LegacyDurableToolResult {
    function_id: string
    dline_tid: string
    result: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
}

function hasIdentity(value: Record<string, unknown>): value is Record<string, unknown> & {
    function_id: string
    dline_tid: string
} {
    return (
        typeof value.function_id === "string" &&
        value.function_id.length > 0 &&
        typeof value.dline_tid === "string" &&
        value.dline_tid.length > 0
    )
}

function isToolResponseContent(value: unknown): value is ClineToolResponseContent {
    return typeof value === "string" || Array.isArray(value)
}

function readTextReplay(value: unknown): DurableToolResultTextReplay | undefined | false {
    if (value === undefined) return undefined
    if (!isRecord(value) || value.kind !== "text" || typeof value.tool_name !== "string" || value.tool_name.length === 0) {
        return false
    }
    return { kind: "text", toolName: value.tool_name, ...(value.described === true ? { described: true } : {}) }
}

/**
 * Decide how an invocation's result returns to the provider.
 *
 * @param invocation The tool name and the replay the provider boundary chose for the call.
 * @returns A text replay for a call that was never recorded as a tool call; otherwise undefined.
 */
export function toolResultReplayOf(
    invocation: {
        readonly toolName: string
        readonly resultReplay?: "text"
    },
    described = false,
): DurableToolResultTextReplay | undefined {
    if (invocation.resultReplay !== "text") return undefined
    return { kind: "text", toolName: invocation.toolName, ...(described ? { described: true } : {}) }
}

/**
 * Serialize the exact canonical tool result inserted into the next API turn.
 *
 * @param result Canonical result carrying the call identity.
 * @param replay Present only when the call has no recorded tool call to pair with.
 */
export function serializeDurableToolResult(
    result: ClineUserToolResultContentBlock,
    replay?: DurableToolResultTextReplay,
): string {
    const persisted: DurableToolResultV1 = {
        version: DURABLE_TOOL_RESULT_VERSION,
        function_id: result.function_id,
        dline_tid: result.dline_tid,
        content: result.content,
        is_error: result.is_error ?? null,
        ...(replay === undefined
            ? {}
            : {
                  replay: {
                      kind: replay.kind,
                      tool_name: replay.toolName,
                      ...(replay.described ? { described: true as const } : {}),
                  },
              }),
    }
    return JSON.stringify(persisted)
}

/** A durable result together with how it returns to the provider. */
export interface DurableToolResultRecord {
    readonly block: ClineUserToolResultContentBlock
    /** Present only when the call has no recorded tool call to pair with. */
    readonly replay?: DurableToolResultTextReplay
}

/** Read a durable result, keeping the replay it was written with. */
export function readDurableToolResult(text: string): DurableToolResultRecord | undefined {
    let value: unknown
    try {
        value = JSON.parse(text)
    } catch {
        return undefined
    }
    if (!isRecord(value) || !hasIdentity(value)) return undefined

    if (value.version === DURABLE_TOOL_RESULT_VERSION) {
        if (!isToolResponseContent(value.content) || (value.is_error !== null && typeof value.is_error !== "boolean")) {
            return undefined
        }
        const replay = readTextReplay(value.replay)
        if (replay === false) return undefined
        return {
            block: {
                type: "tool_result",
                function_id: value.function_id,
                dline_tid: value.dline_tid,
                content: value.content,
                ...(value.is_error === null ? {} : { is_error: value.is_error }),
            },
            ...(replay === undefined ? {} : { replay }),
        }
    }

    // Legacy rows only stored one ambiguous string. Treat it literally; parsing
    // strings such as "[]" would silently change a valid textual tool result.
    if (value.version === undefined && typeof value.result === "string") {
        const legacy = value as unknown as LegacyDurableToolResult
        return {
            block: {
                type: "tool_result",
                function_id: legacy.function_id,
                dline_tid: legacy.dline_tid,
                content: [{ type: "text", text: legacy.result || "(tool did not return anything)" }],
            },
        }
    }

    return undefined
}

/**
 * Parse a durable result without guessing whether an unversioned string was
 * originally JSON text or structured content.
 */
export function parseDurableToolResult(text: string): ClineUserToolResultContentBlock | undefined {
    return readDurableToolResult(text)?.block
}

/** Present a result whose call was never recorded as prose the model can read beside its own markup. */
function textReplayContent(block: ClineUserToolResultContentBlock, replay: DurableToolResultTextReplay): ClineUserContent[] {
    const parts = typeof block.content === "string" ? [{ type: "text" as const, text: block.content }] : block.content
    const text = parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n\n")
    const images = parts.filter((part) => part.type === "image")
    const described =
        replay.described && text ? text : `[${replay.toolName}] Result:\n${text || "(tool did not return anything)"}`
    return [{ type: "text", text: described }, ...images]
}

/**
 * Build the user content that carries one durable result into the next provider turn.
 *
 * @returns The paired canonical result, or prose for a call that was never recorded as a tool call.
 */
export function replayContentOf(record: DurableToolResultRecord): ClineUserContent[] {
    return record.replay ? textReplayContent(record.block, record.replay) : [record.block]
}

/** Parse and replay a serialized durable result; undefined when it is not one. */
export function replayDurableToolResult(text: string): ClineUserContent[] | undefined {
    const record = readDurableToolResult(text)
    return record ? replayContentOf(record) : undefined
}
