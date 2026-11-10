import type { MockApiConsumption } from "@e2e/fixtures/server"
import { expect } from "@playwright/test"

interface ParsedCompactionBudget {
    availableRemainder: number
    hardLimit: number
    recommendedMin: number
    recommendedMax: number
}

export function estimateTokens(value: unknown): number {
    return Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(value), "utf8") / 4))
}

export function countOccurrences(text: string, marker: string): number {
    return text.split(marker).length - 1
}

function parseCompactionBudget(requestBody: unknown): ParsedCompactionBudget {
    const requestText = JSON.stringify(requestBody)
    const available = requestText.match(/Estimated available context-window remainder: ([0-9]+) tokens/)
    const hardLimit = requestText.match(/Hard limit for the complete response: ([0-9]+) tokens/)
    const recommended = requestText.match(/Recommended total response range: ([0-9]+)[–-]([0-9]+) tokens/)
    if (!available || !hardLimit || !recommended) {
        throw new Error("Compaction request is missing the complete window-budget guidance")
    }
    return {
        availableRemainder: Number(available[1]),
        hardLimit: Number(hardLimit[1]),
        recommendedMin: Number(recommended[1]),
        recommendedMax: Number(recommended[2]),
    }
}

export function expectCompactionBudgetFormula(
    requestBody: unknown,
    modelMaxOutputTokens = 8_192,
    summaryCarryLimit = Number.POSITIVE_INFINITY,
): ParsedCompactionBudget {
    const budget = parseCompactionBudget(requestBody)
    const body = requestBody as { max_output_tokens?: unknown; max_tokens?: unknown; max_completion_tokens?: unknown }
    const declaredMaxOutput = body.max_output_tokens ?? body.max_tokens ?? body.max_completion_tokens
    const expectedHardLimit = Math.min(
        Math.floor(budget.availableRemainder * 0.9),
        Math.max(0, budget.availableRemainder - 3_000),
        modelMaxOutputTokens,
        summaryCarryLimit < 512 ? Number.POSITIVE_INFINITY : summaryCarryLimit,
    )
    if (declaredMaxOutput !== undefined) expect(declaredMaxOutput).toBe(expectedHardLimit)

    // The recommended range is bounded by the remaining window and by the hard limit: advising a
    // longer response than the request can emit would guarantee truncation.
    const expectedRecommendedMax = Math.min(Math.floor(budget.availableRemainder * 0.9), 30_000, budget.hardLimit)
    const expectedRecommendedMin = Math.min(Math.floor(budget.availableRemainder * 0.8), 5_000, expectedRecommendedMax)

    expect(budget.availableRemainder).toBeGreaterThan(0)
    expect(budget.hardLimit).toBe(expectedHardLimit)
    expect(budget.recommendedMin).toBe(expectedRecommendedMin)
    expect(budget.recommendedMax).toBe(expectedRecommendedMax)
    expect(budget.recommendedMin).toBeLessThanOrEqual(budget.recommendedMax)
    expect(budget.recommendedMax).toBeLessThanOrEqual(budget.availableRemainder)
    expect(budget.recommendedMax).toBeLessThanOrEqual(budget.hardLimit)
    return budget
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined
}

function asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : []
}

type RequestWire = Pick<MockApiConsumption, "target" | "requestBody">
type HistoryEvent =
    | { kind: "text"; role: string; text: string }
    | { kind: "call"; callId: string; name: unknown; input: unknown }
    | { kind: "result"; callId: string; content: unknown }

function requiredId(value: unknown): string {
    expect(value).toEqual(expect.any(String))
    expect(value).not.toBe("")
    return value as string
}

/** Read only the grammar consumed by this endpoint, never another protocol's parallel fields. */
function historyEvents(request: RequestWire): HistoryEvent[] {
    const body = asRecord(request.requestBody)
    const responses = request.target === "openai-compatible-responses"
    const anthropic = request.target === "anthropic-messages"
    expect(body?.[responses ? "messages" : "input"]).toBeUndefined()
    const messages = body?.[responses ? "input" : "messages"]
    expect(Array.isArray(messages)).toBe(true)
    const events: HistoryEvent[] = []
    for (const value of asArray(messages)) {
        const message = asRecord(value)
        if (responses && message?.type === "function_call") {
            events.push({
                kind: "call",
                callId: requiredId(message.call_id),
                name: message.name,
                input: JSON.parse(String(message.arguments)),
            })
            continue
        }
        if (responses && message?.type === "function_call_output") {
            events.push({ kind: "result", callId: requiredId(message.call_id), content: message.output })
            continue
        }
        if (message?.role === "tool") {
            expect(responses || anthropic).toBe(false)
            events.push({ kind: "result", callId: requiredId(message.tool_call_id), content: message.content })
            continue
        }
        const role = String(message?.role)
        if (typeof message?.content === "string") events.push({ kind: "text", role, text: message.content })
        for (const value of asArray(message?.content)) {
            const block = asRecord(value)
            if (block?.type === "tool_use") {
                expect(anthropic).toBe(true)
                expect(role).toBe("assistant")
                events.push({ kind: "call", callId: requiredId(block.id), name: block.name, input: block.input })
            } else if (block?.type === "tool_result") {
                expect(anthropic).toBe(true)
                expect(role).toBe("user")
                events.push({ kind: "result", callId: requiredId(block.tool_use_id), content: block.content })
            } else if (block?.type === "text" || block?.type === "input_text" || block?.type === "output_text") {
                expect(block.type).toBe(responses ? (role === "assistant" ? "output_text" : "input_text") : "text")
                expect(block.text).toEqual(expect.any(String))
                events.push({ kind: "text", role, text: String(block.text) })
            }
        }
        for (const value of asArray(message?.tool_calls)) {
            expect(responses || anthropic).toBe(false)
            expect(role).toBe("assistant")
            const call = asRecord(value)
            const fn = asRecord(call?.function)
            events.push({ kind: "call", callId: requiredId(call?.id), name: fn?.name, input: JSON.parse(String(fn?.arguments)) })
        }
    }
    return events
}

function requestTextBlocks(request: RequestWire, role: "user" | "assistant"): string[] {
    return historyEvents(request).flatMap((event) => (event.kind === "text" && event.role === role ? [event.text] : []))
}

/** User prose only: a tool output or assistant argument must never masquerade as the latest input. */
export function requestUserTextBlocks(request: RequestWire): string[] {
    return requestTextBlocks(request, "user")
}

interface ExpectedQnaTurn {
    callId: string
    user: string
    response: string
}

function requestQnaCalls(request: RequestWire): Array<{ callId: string; name: unknown; input: unknown }> {
    return historyEvents(request).flatMap((event) =>
        event.kind === "call" ? [{ callId: event.callId, name: event.name, input: event.input }] : [],
    )
}

function textPosition(events: readonly HistoryEvent[], role: string, text: string): number {
    return events.findIndex((event) => event.kind === "text" && event.role === role && event.text.includes(text))
}

function expectTurnOrder(request: RequestWire, turns: readonly ExpectedQnaTurn[], carry?: string): number {
    const events = historyEvents(request)
    let last = carry ? textPosition(events, "user", carry) : -1
    if (carry) expect(last).toBeGreaterThanOrEqual(0)
    for (const turn of turns) {
        const user = textPosition(events, "user", turn.user)
        const call = events.findIndex((event) => event.kind === "call" && event.callId === turn.callId)
        const result = events.findIndex((event) => event.kind === "result" && event.callId === turn.callId)
        expect(user).toBeGreaterThan(last)
        expect(call).toBeGreaterThan(user)
        expect(result).toBeGreaterThan(call)
        last = result
    }
    return last
}

export function expectCompleteToolPairing(request: MockApiConsumption, expectedCallIds: readonly string[]): void {
    const events = historyEvents(request)
    const pending = new Set<string>()
    const calls: string[] = []
    const outputs: string[] = []
    for (const event of events) {
        if (event.kind === "call") {
            expect(calls).not.toContain(event.callId)
            pending.add(event.callId)
            calls.push(event.callId)
        } else if (event.kind === "result") {
            expect(pending.has(event.callId)).toBe(true)
            pending.delete(event.callId)
            outputs.push(event.callId)
        }
    }
    expect([...pending]).toEqual([])
    expect(calls).toEqual(expectedCallIds)
    expect(outputs).toEqual(expectedCallIds)
    expect(request.contractError).toBeUndefined()
    expect(request.requestToolPairing).toEqual({
        callIds: expectedCallIds,
        outputIds: expectedCallIds,
        missingOutputIds: [],
        orphanOutputIds: [],
        duplicateCallIds: [],
        duplicateOutputIds: [],
        complete: true,
    })
}

function toolResultText(content: unknown): string {
    if (typeof content === "string") return content
    if (!Array.isArray(content)) return JSON.stringify(content) ?? ""
    return content
        .map((value) => {
            const block = asRecord(value)
            return typeof block?.text === "string" ? block.text : (JSON.stringify(value) ?? "")
        })
        .join("\n")
}

/** Owned feedback is user prose exactly once, never copied into the paired tool output. */
export function expectOwnedUserFeedback(
    request: MockApiConsumption,
    expectedCallIds: readonly string[],
    markers: readonly string[],
): void {
    expectCompleteToolPairing(request, expectedCallIds)
    const events = historyEvents(request)
    const userText = requestUserTextBlocks(request).join("\n")
    for (const marker of markers) {
        expect(countOccurrences(userText, marker), `Owned user feedback: ${marker}`).toBe(1)
        for (const event of events) {
            if (event.kind === "result") expect(toolResultText(event.content)).not.toContain(marker)
        }
    }
}

/** The oracle is fixture-owned: exact original turns and identities, not production's chosen range. */
export function expectCompactionSource(
    request: MockApiConsumption,
    input: {
        turns: readonly ExpectedQnaTurn[]
        textTurns?: readonly { user: string; response: string }[]
        carry?: string
        excluded: readonly string[]
        contextWindow: number
    },
): void {
    expect(request).toMatchObject({ responseType: "tool", toolName: "summarize_task" })
    expectCompleteToolPairing(
        request,
        input.turns.map((turn) => turn.callId),
    )
    expect(requestQnaCalls(request)).toEqual(
        input.turns.map((turn) => ({ callId: turn.callId, name: "qna_respond", input: { response: turn.response } })),
    )
    const userText = requestUserTextBlocks(request).join("\n")
    for (const turn of input.turns) expect(countOccurrences(userText, turn.user)).toBe(1)
    const events = historyEvents(request)
    let last = expectTurnOrder(request, input.turns, input.carry)
    const assistantText = requestTextBlocks(request, "assistant").join("\n")
    for (const turn of input.textTurns ?? []) {
        expect(countOccurrences(userText, turn.user)).toBe(1)
        expect(countOccurrences(assistantText, turn.response)).toBe(1)
        const user = textPosition(events, "user", turn.user)
        const assistant = textPosition(events, "assistant", turn.response)
        expect(user).toBeGreaterThan(last)
        expect(assistant).toBeGreaterThan(user)
        last = assistant
    }
    if (input.carry) expect(countOccurrences(userText, input.carry)).toBe(1)
    const closing = events.flatMap((event, index) =>
        event.kind === "text" && event.role === "user"
            ? [...event.text.matchAll(/<explicit_instructions type="summarize_task">[\s\S]*?<\/explicit_instructions>/g)].map(
                  () => index,
              )
            : [],
    )
    expect(closing).toHaveLength(1)
    expect(closing[0]).toBeGreaterThan(last)
    const toolNames = asArray(asRecord(request.requestBody)?.tools).map((tool) => {
        const definition = asRecord(tool)
        return definition?.name ?? asRecord(definition?.function)?.name
    })
    expect(toolNames).not.toContain("summarize_task")
    const text = JSON.stringify(request.requestBody)
    for (const marker of input.excluded) expect(text).not.toContain(marker)
    // The fixture declares the 8,192-token cap independently of the emitted wire budget.
    const budget = expectCompactionBudgetFormula(request.requestBody)
    expect(budget.availableRemainder).toBeLessThan(input.contextWindow)
    expect(budget.hardLimit).toBeGreaterThan(0)
    expect(budget.hardLimit + 3_000).toBeLessThanOrEqual(budget.availableRemainder)
    expect(budget.hardLimit).toBeLessThanOrEqual(Math.floor(budget.availableRemainder * 0.9))
}

export function expectLatestUserOnce(request: MockApiConsumption, latestUser: string, marker: string): void {
    const userText = requestUserTextBlocks(request).join("\n")
    expect(countOccurrences(userText, latestUser)).toBe(1)
    expect(countOccurrences(JSON.stringify(request.requestBody), marker)).toBe(1)
    for (const result of request.requestToolResults) expect(result.content).not.toContain(marker)
}

export function expectCompactedContinuation(
    request: MockApiConsumption,
    input: {
        summary: string
        latestUser: string
        latestMarker: string
        excluded: readonly string[]
        retainedTurns?: readonly ExpectedQnaTurn[]
        tokenLimit: number
    },
): void {
    expect(request).toMatchObject({ responseType: "tool", toolName: "attempt_completion" })
    const turns = input.retainedTurns ?? []
    expectCompleteToolPairing(
        request,
        turns.map((turn) => turn.callId),
    )
    expect(requestQnaCalls(request)).toEqual(
        turns.map((turn) => ({ callId: turn.callId, name: "qna_respond", input: { response: turn.response } })),
    )
    const userText = requestUserTextBlocks(request).join("\n")
    for (const turn of turns) expect(countOccurrences(userText, turn.user)).toBe(1)
    expect(countOccurrences(userText, input.summary)).toBe(1)
    expectLatestUserOnce(request, input.latestUser, input.latestMarker)
    const last = expectTurnOrder(request, turns, input.summary)
    expect(textPosition(historyEvents(request), "user", input.latestUser)).toBeGreaterThan(last)
    const text = JSON.stringify(request.requestBody)
    expect(userText).not.toContain('<explicit_instructions type="summarize_task">')
    for (const marker of input.excluded) expect(text).not.toContain(marker)
    expect(estimateTokens(request.requestBody)).toBeLessThan(input.tokenLimit)
}
