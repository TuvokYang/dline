import type { UiMessage } from "@shared/ExtensionMessage"
import { TaskRateMetricPoint, TaskRateUsageQuality } from "@shared/proto/dline/task"
import { describe, expect, it } from "vitest"
import { bindFoldUsage, captureFoldUsageRequests } from "./foldUsageBinding"

const request = (ts: number, finished = true): UiMessage => ({
    ts,
    type: "say",
    say: "api_req_started",
    text: JSON.stringify({ request: "prompt", ...(finished ? { cost: 0 } : {}) }),
})
const point = (roundId: string, overrides: Partial<TaskRateMetricPoint> = {}) =>
    TaskRateMetricPoint.create({
        roundId,
        providerDurationMs: 2_000,
        inputTokens: 200,
        outputTokens: 100,
        usageQuality: TaskRateUsageQuality.TASK_RATE_USAGE_QUALITY_EXACT,
        ...overrides,
    })

// These cases catch sliding attribution, dropped empty slots, and UI/metric races.
describe("query-snapshot fold usage binding", () => {
    it("excludes user buckets and an unfinished send from the retained tail", () => {
        const messages: UiMessage[] = [
            { ts: 1, type: "say", say: "task" },
            request(10),
            { ts: 20, type: "say", say: "user_feedback" },
            request(30, false),
        ]
        const binding = bindFoldUsage(captureFoldUsageRequests(messages), [point("old")])
        expect([...binding.byRequest.keys()]).toEqual([10])
        expect(binding.byRequest.get(10)?.[0].outputTokens).toBe(100)
    })

    it("keeps a known round on its original send after later sends finish", () => {
        const first = bindFoldUsage(captureFoldUsageRequests([request(10)]), [point("old")])
        const refreshed = bindFoldUsage(
            captureFoldUsageRequests([request(10), request(20)]),
            [point("old", { outputTokens: 150 })],
            first,
        )
        expect([...refreshed.byRequest.keys()]).toEqual([10])
        expect(refreshed.byRequest.get(10)?.[0].outputTokens).toBe(150)
    })

    it("does not compress empty metric records before allocating legacy slots", () => {
        const empty = TaskRateMetricPoint.create({ roundId: "empty" })
        const binding = bindFoldUsage(captureFoldUsageRequests([request(10), request(20)]), [point("old"), empty])
        expect(binding.requestByRoundId.get("empty")).toBe(20)
        expect(binding.byRequest.get(10)?.[0].roundId).toBe("old")
        expect(binding.byRequest.has(20)).toBe(false)
    })

    it("rejects a terminal metric racing ahead of its still-live UI send", () => {
        const requests = captureFoldUsageRequests([request(10), request(20, false)])
        const binding = bindFoldUsage(requests, [point("old", { startedAtMs: 11 }), point("new", { startedAtMs: 21 })])
        expect(binding.byRequest.get(10)?.map((usage) => usage.roundId)).toEqual(["old"])
        expect(binding.byRequest.has(20)).toBe(false)
        expect(binding.requestByRoundId.has("new")).toBe(false)
    })

    it("keeps multiple measured attempts on the send selected by timing", () => {
        const binding = bindFoldUsage(captureFoldUsageRequests([request(10), request(30)]), [
            point("retry-0", { startedAtMs: 11 }),
            point("retry-1", { startedAtMs: 15 }),
            point("next", { startedAtMs: 31 }),
        ])
        expect(binding.byRequest.get(10)?.map((usage) => usage.roundId)).toEqual(["retry-0", "retry-1"])
        expect(binding.byRequest.get(30)?.map((usage) => usage.roundId)).toEqual(["next"])
    })

    it("never reassigns a known round when its send leaves the loaded window", () => {
        const first = bindFoldUsage(captureFoldUsageRequests([request(10)]), [point("old", { startedAtMs: 11 })])
        const shifted = bindFoldUsage(captureFoldUsageRequests([request(20)]), [point("old", { startedAtMs: 11 })], first)
        expect(shifted.byRequest.has(20)).toBe(false)
        expect(shifted.requestByRoundId.get("old")).toBe(10)
    })

    it("remembers ownership across an empty response before later sends finish", () => {
        const first = bindFoldUsage(captureFoldUsageRequests([request(10)]), [point("old")])
        const empty = bindFoldUsage(captureFoldUsageRequests([request(10)]), [], first)
        const resumed = bindFoldUsage(captureFoldUsageRequests([request(10), request(20)]), [point("old")], empty)
        expect([...resumed.byRequest.keys()]).toEqual([10])
    })

    it("uses later sends and settled turn ends when the live window still holds opening-only API rows", () => {
        const pending = [request(10, false), request(20, false)]
        expect(captureFoldUsageRequests(pending).map((send) => send.finished)).toEqual([true, false])
        const ended: UiMessage[] = [...pending, { ts: 30, type: "ask", ask: "qna_respond", partial: false }]
        expect(captureFoldUsageRequests(ended).map((send) => send.finished)).toEqual([true, true])
        const userNote: UiMessage[] = [request(10, false), { ts: 20, type: "say", say: "user_feedback" }]
        expect(captureFoldUsageRequests(userNote)[0].finished).toBe(false)
    })

    it("invalidates on usage revision, not prompt text or unrelated streamed rows", () => {
        const original = [request(10)]
        const streamed: UiMessage[] = [
            { ...original[0], text: JSON.stringify({ request: "changed context", cost: 0 }) },
            { ts: 11, type: "say", say: "reasoning", text: "streaming", partial: true },
        ]
        expect(captureFoldUsageRequests(streamed)).toEqual(captureFoldUsageRequests(original))
        streamed[0] = { ...streamed[0], text: JSON.stringify({ cost: 0, tokensOut: 30 }) }
        expect(captureFoldUsageRequests(streamed)).not.toEqual(captureFoldUsageRequests(original))
    })
})
