import { createHash } from "node:crypto"
import { envFlagEnabled } from "@shared/env"
import type { ClineStorageMessage } from "@shared/messages/content"

export type CompactionDiagnosticRequestKind = "ordinary" | "automatic_compaction" | "manual_compaction"

export interface CompactionDiagnosticMessageShape {
    readonly role: ClineStorageMessage["role"]
    readonly contentTypes: readonly string[]
    readonly bytes: number
}

export interface CompactionProviderDiagnosticSnapshot {
    readonly requestKind: CompactionDiagnosticRequestKind
    readonly providerId: string
    readonly modelId: string
    readonly apiFormat: string | null
    readonly systemPromptHash: string
    readonly toolsHash: string
    readonly serverToolsHash: string
    readonly promptIdentityHash: string
    readonly messageHashes: readonly string[]
    readonly messageShapes: readonly CompactionDiagnosticMessageShape[]
}

export interface CompactionProviderFirstDivergence {
    readonly component: "system_prompt" | "tools" | "server_tools" | "messages" | null
    readonly messageIndex: number | null
    readonly baselineHash: string | null
    readonly currentHash: string | null
    readonly baselineShape: CompactionDiagnosticMessageShape | null
    readonly currentShape: CompactionDiagnosticMessageShape | null
}

export function isCompactionDevDiagnosticsEnabled(): boolean {
    return envFlagEnabled(process.env.IS_DEV)
}

/** Hash one diagnostic value without retaining or logging its source content. */
export function hashCompactionDiagnosticValue(value: unknown): string {
    return `sha256:${createHash("sha256")
        .update(JSON.stringify(value) ?? "")
        .digest("hex")}`
}

export function createCompactionProviderDiagnosticSnapshot(input: {
    requestKind: CompactionDiagnosticRequestKind
    providerId: string
    modelId: string
    apiFormat?: unknown
    systemPrompt: string
    messages: readonly ClineStorageMessage[]
    tools?: readonly unknown[]
    serverTools?: readonly unknown[]
}): CompactionProviderDiagnosticSnapshot {
    const systemPromptHash = hashCompactionDiagnosticValue(input.systemPrompt)
    const toolsHash = hashCompactionDiagnosticValue(input.tools ?? [])
    const serverToolsHash = hashCompactionDiagnosticValue(input.serverTools ?? [])
    return {
        requestKind: input.requestKind,
        providerId: input.providerId,
        modelId: input.modelId,
        apiFormat: input.apiFormat === undefined || input.apiFormat === null ? null : String(input.apiFormat),
        systemPromptHash,
        toolsHash,
        serverToolsHash,
        promptIdentityHash: hashCompactionDiagnosticValue({
            providerId: input.providerId,
            modelId: input.modelId,
            apiFormat: input.apiFormat ?? null,
            systemPromptHash,
            toolsHash,
            serverToolsHash,
        }),
        messageHashes: input.messages.map(hashCompactionDiagnosticValue),
        messageShapes: input.messages.map(summarizeMessageShape),
    }
}

export function findCompactionProviderFirstDivergence(
    baseline: CompactionProviderDiagnosticSnapshot,
    current: CompactionProviderDiagnosticSnapshot,
): CompactionProviderFirstDivergence {
    for (const component of ["system_prompt", "tools", "server_tools"] as const) {
        const [baselineHash, currentHash] = hashesForComponent(component, baseline, current)
        if (baselineHash !== currentHash) {
            return {
                component,
                messageIndex: null,
                baselineHash,
                currentHash,
                baselineShape: null,
                currentShape: null,
            }
        }
    }

    const length = Math.max(baseline.messageHashes.length, current.messageHashes.length)
    for (let index = 0; index < length; index++) {
        const baselineHash = baseline.messageHashes[index] ?? null
        const currentHash = current.messageHashes[index] ?? null
        if (baselineHash !== currentHash) {
            return {
                component: "messages",
                messageIndex: index,
                baselineHash,
                currentHash,
                baselineShape: baseline.messageShapes[index] ?? null,
                currentShape: current.messageShapes[index] ?? null,
            }
        }
    }

    return {
        component: null,
        messageIndex: null,
        baselineHash: null,
        currentHash: null,
        baselineShape: null,
        currentShape: null,
    }
}

export interface CompactionWireItemShape {
    readonly type: string
    readonly bytes: number
}

export interface CompactionWireDiagnosticSnapshot {
    readonly requestKind: "ordinary" | "compaction"
    readonly promptCacheKeyHash: string
    readonly instructionsHash: string
    readonly toolsHash: string
    readonly previousResponseIdHash: string
    readonly inputHashes: readonly string[]
    readonly inputShapes: readonly CompactionWireItemShape[]
}

export interface CompactionWireFirstDivergence {
    readonly component: "prompt_cache_key" | "instructions" | "tools" | "previous_response_id" | "input" | null
    readonly inputIndex: number | null
    readonly baselineHash: string | null
    readonly currentHash: string | null
    readonly baselineShape: CompactionWireItemShape | null
    readonly currentShape: CompactionWireItemShape | null
}

export function createCompactionWireDiagnosticSnapshot(input: {
    requestKind: "ordinary" | "compaction"
    promptCacheKey: string
    instructions?: unknown
    tools?: readonly unknown[]
    previousResponseId?: string
    wireInput: unknown
}): CompactionWireDiagnosticSnapshot {
    const inputItems = Array.isArray(input.wireInput) ? input.wireInput : [input.wireInput]
    return {
        requestKind: input.requestKind,
        promptCacheKeyHash: hashCompactionDiagnosticValue(input.promptCacheKey),
        instructionsHash: hashCompactionDiagnosticValue(input.instructions ?? null),
        toolsHash: hashCompactionDiagnosticValue(input.tools ?? []),
        previousResponseIdHash: hashCompactionDiagnosticValue(input.previousResponseId ?? null),
        inputHashes: inputItems.map(hashCompactionDiagnosticValue),
        inputShapes: inputItems.map(summarizeWireItemShape),
    }
}

export function findCompactionWireFirstDivergence(
    baseline: CompactionWireDiagnosticSnapshot,
    current: CompactionWireDiagnosticSnapshot,
): CompactionWireFirstDivergence {
    for (const component of ["prompt_cache_key", "instructions", "tools", "previous_response_id"] as const) {
        const [baselineHash, currentHash] = wireHashesForComponent(component, baseline, current)
        if (baselineHash !== currentHash) {
            return {
                component,
                inputIndex: null,
                baselineHash,
                currentHash,
                baselineShape: null,
                currentShape: null,
            }
        }
    }

    const length = Math.max(baseline.inputHashes.length, current.inputHashes.length)
    for (let index = 0; index < length; index++) {
        const baselineHash = baseline.inputHashes[index] ?? null
        const currentHash = current.inputHashes[index] ?? null
        if (baselineHash !== currentHash) {
            return {
                component: "input",
                inputIndex: index,
                baselineHash,
                currentHash,
                baselineShape: baseline.inputShapes[index] ?? null,
                currentShape: current.inputShapes[index] ?? null,
            }
        }
    }

    return {
        component: null,
        inputIndex: null,
        baselineHash: null,
        currentHash: null,
        baselineShape: null,
        currentShape: null,
    }
}

function summarizeMessageShape(message: ClineStorageMessage): CompactionDiagnosticMessageShape {
    const contentTypes = Array.isArray(message.content)
        ? message.content.map((block) =>
              typeof block === "object" && block !== null && "type" in block ? String(block.type) : typeof block,
          )
        : [typeof message.content]
    return {
        role: message.role,
        contentTypes,
        bytes: Buffer.byteLength(JSON.stringify(message), "utf8"),
    }
}

function summarizeWireItemShape(value: unknown): CompactionWireItemShape {
    const type =
        typeof value === "object" && value !== null && "type" in value
            ? String((value as { type?: unknown }).type ?? "object")
            : Array.isArray(value)
              ? "array"
              : typeof value
    return {
        type,
        bytes: Buffer.byteLength(JSON.stringify(value) ?? "", "utf8"),
    }
}

function wireHashesForComponent(
    component: "prompt_cache_key" | "instructions" | "tools" | "previous_response_id",
    baseline: CompactionWireDiagnosticSnapshot,
    current: CompactionWireDiagnosticSnapshot,
): readonly [string, string] {
    switch (component) {
        case "prompt_cache_key":
            return [baseline.promptCacheKeyHash, current.promptCacheKeyHash]
        case "instructions":
            return [baseline.instructionsHash, current.instructionsHash]
        case "tools":
            return [baseline.toolsHash, current.toolsHash]
        case "previous_response_id":
            return [baseline.previousResponseIdHash, current.previousResponseIdHash]
    }
}

function hashesForComponent(
    component: "system_prompt" | "tools" | "server_tools",
    baseline: CompactionProviderDiagnosticSnapshot,
    current: CompactionProviderDiagnosticSnapshot,
): readonly [string, string] {
    switch (component) {
        case "system_prompt":
            return [baseline.systemPromptHash, current.systemPromptHash]
        case "tools":
            return [baseline.toolsHash, current.toolsHash]
        case "server_tools":
            return [baseline.serverToolsHash, current.serverToolsHash]
    }
}
