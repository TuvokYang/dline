import { DISABLED_WEB_SEARCH_ROUTING_PLAN } from "@core/prompts/__tests__/web-search-routing-fixtures"
import { PromptProfile } from "@core/prompts/profiles/types"
import type { ClineStorageMessage } from "@shared/messages/content"
import { describe, expect, it, vi } from "vitest"
import type { ProviderRequestFrame } from "../../executors/provider/service/ProviderRequest"
import { CompactionRequestScopes } from "../CompactionRequestScopes"
import { ProviderCompactionService } from "../ProviderCompactionService"

/** One complete logical turn: the smallest conversation a Pass can summarize. */
const SOURCE: ClineStorageMessage[] = [
    { role: "user", content: [{ type: "text", text: "original task" }] },
    { role: "assistant", content: [{ type: "text", text: "first answer" }] },
]

/** A Pass is only accepted with the usage the provider reported for it. */
const USAGE = { type: "usage", inputTokens: 100, outputTokens: 10 }

interface FrameProbe {
    readonly frame: ProviderRequestFrame
    readonly calls: unknown[][]
}

interface ModelLimits {
    readonly contextWindow: number
    readonly maxTokens?: number
}

const SUMMARY_TEXT = "<summarize_task><context>THE SUMMARY</context></summarize_task>"

function probe(chunks: readonly unknown[], limits: ModelLimits = { contextWindow: 200_000, maxTokens: 64_000 }): FrameProbe {
    const calls: unknown[][] = []
    const api = {
        createMessage: (...args: unknown[]) => {
            calls.push(args)
            return (async function* () {
                for (const chunk of chunks) yield chunk
                yield USAGE
            })()
        },
        abort: () => undefined,
        getModel: () => ({ id: "probe-model", info: { capabilities: limits } }),
        getProviderId: () => "openai",
    }
    return {
        calls,
        frame: {
            api: api as unknown as ProviderRequestFrame["api"],
            systemPrompt: "ORDINARY_SYSTEM_PROMPT",
            tools: [{ type: "function", function: { name: "read_file" } }] as unknown as ProviderRequestFrame["tools"],
            options: { taskNamespace: "task-1", serverTools: [], retryOwner: "task" },
            nativeTools: true,
            serverToolContext: {
                webSearchRoutingPlan: DISABLED_WEB_SEARCH_ROUTING_PLAN,
                providerId: "openai",
                imageGeneration: { enabled: false, providerId: "openai", modelId: "probe-model" },
            },
            mode: "serial",
            profile: PromptProfile.Lite,
        },
    }
}

type ServiceOptions = ConstructorParameters<typeof ProviderCompactionService>[0]

function service(
    frame: ProviderRequestFrame,
    triggerOptions?: ServiceOptions["triggerOptions"],
    ports: Pick<ServiceOptions, "environment" | "indicator" | "requestPressures"> = {},
): ProviderCompactionService {
    return new ProviderCompactionService({
        frames: { frame: async () => frame },
        // The budget block is stated only when the window leaves output room, so
        // it is kept out of the instruction text these cases compare.
        instruction: (resolved, budget) => `SUMMARIZE_INSTRUCTION:${resolved.profile}${budget ? `\n${budget}` : ""}`,
        ...(triggerOptions ? { triggerOptions } : {}),
        ...ports,
    })
}

/** Two turns that each take about half of a 200k window, so one Pass is enough on its own. */
const TWO_LARGE_TURNS = {
    sourceHistory: [
        { role: "user", content: [{ type: "text", text: "task A" }] },
        { role: "assistant", content: [{ type: "text", text: "a".repeat(400_000) }] },
        { role: "user", content: [{ type: "text", text: "task B" }] },
        { role: "assistant", content: [{ type: "text", text: "b".repeat(400_000) }] },
    ] satisfies ClineStorageMessage[],
    sourceRanges: [
        [11, 11],
        [12, 12],
        [13, 13],
        [14, 14],
    ],
}

function lastText(calls: unknown[][]): string {
    const messages = calls[0]?.[1] as ClineStorageMessage[]
    const content = messages[messages.length - 1]?.content
    return Array.isArray(content) ? content.map((block) => ("text" in block ? block.text : "")).join("") : String(content)
}

function outputCap(calls: unknown[][]): number | undefined {
    return (calls[0]?.[3] as { generation?: { maxOutputTokens?: number } } | undefined)?.generation?.maxOutputTokens
}

async function run(target: ProviderCompactionService, context: unknown): Promise<unknown> {
    return target.run({
        compactionId: "compaction:1",
        attempt: "compaction:1:1",
        context,
        signal: new AbortController().signal,
        publish: () => undefined,
    })
}

describe("ProviderCompactionService", () => {
    it("sends the ordinary system prompt and tools so the provider prefix cache survives the compaction", async () => {
        const { frame, calls } = probe([{ type: "text", text: SUMMARY_TEXT }])

        const result = await run(service(frame), { sourceHistory: SOURCE })

        const [systemPrompt, messages, tools, options] = calls[0] ?? []
        expect(systemPrompt).toBe("ORDINARY_SYSTEM_PROMPT")
        expect(tools).toEqual(frame.tools)
        expect(options).toMatchObject({
            taskNamespace: "task-1",
            serverTools: [],
            generation: { purpose: "compaction" },
        })
        // The instruction rides as the last user message: the prefix the provider
        // cached for the ordinary request is the source history unchanged.
        expect(messages).toEqual([
            ...SOURCE,
            // The instruction is rendered for the profile the frame's prompt used.
            {
                role: "user",
                content: [
                    { type: "text", text: expect.stringMatching(/^SUMMARIZE_INSTRUCTION:lite\n# Compaction Window Budget/) },
                ],
                ts: expect.any(Number),
            },
        ])
        expect(result).toMatchObject({ summary: "THE SUMMARY" })
    })

    it("lets the summary use the model's output ceiling when the window holds it", async () => {
        const { frame, calls } = probe([{ type: "text", text: SUMMARY_TEXT }], { contextWindow: 1_000_000, maxTokens: 384_000 })

        await run(service(frame), { sourceHistory: SOURCE })

        expect(outputCap(calls)).toBe(384_000)
        expect(lastText(calls)).toContain("Hard limit for the complete response: 384000 tokens.")
    })

    it("bounds the summary by what the window still holds after the request's input", async () => {
        const { frame, calls } = probe([{ type: "text", text: SUMMARY_TEXT }], { contextWindow: 20_000, maxTokens: 64_000 })

        await run(service(frame), { sourceHistory: SOURCE })

        const cap = outputCap(calls)
        expect(cap).toBeGreaterThan(0)
        expect(cap).toBeLessThan(20_000)
        expect(lastText(calls)).toContain(`Hard limit for the complete response: ${cap} tokens.`)
    })

    it("honours a caller ceiling and the absolute context cap below the model limits", async () => {
        const capped = probe([{ type: "text", text: SUMMARY_TEXT }], { contextWindow: 1_000_000, maxTokens: 384_000 })
        await run(service(capped.frame), { sourceHistory: SOURCE, maxOutputTokens: 12_000 })
        expect(outputCap(capped.calls)).toBe(12_000)

        const absolute = probe([{ type: "text", text: SUMMARY_TEXT }], { contextWindow: 1_000_000, maxTokens: 384_000 })
        await run(
            service(absolute.frame, () => ({ maxContextTokens: 50_000 })),
            { sourceHistory: SOURCE },
        )
        expect(outputCap(absolute.calls)).toBeLessThan(50_000)
    })

    it("uses exact Provider token-per-byte history to maximize complete turns in one Pass", async () => {
        const calibrated = probe([{ type: "text", text: SUMMARY_TEXT }])
        const requestPressures: NonNullable<ServiceOptions["requestPressures"]> = () => [
            {
                providerId: "openai",
                modelId: "probe-model",
                apiFormat: undefined,
                estimatedTextBytes: 1_000,
                estimatedMediaTokens: 0,
                actualInputTokens: 100,
            },
        ]

        await run(service(calibrated.frame, undefined, { requestPressures }), TWO_LARGE_TURNS)

        expect(calibrated.calls).toHaveLength(1)
        const sent = JSON.stringify(calibrated.calls[0]?.[1])
        expect(sent).toContain("task A")
        expect(sent).toContain("task B")
        expect(sent).toContain("a".repeat(1_000))
        expect(sent).toContain("b".repeat(1_000))
    })

    it("prefers the provider official input count over calibrated byte estimation", async () => {
        const counted = probe([{ type: "text", text: SUMMARY_TEXT }])
        const countInputTokens = vi.fn(async () => 100_000)
        ;(counted.frame.api as { countInputTokens?: typeof countInputTokens }).countInputTokens = countInputTokens
        const requestPressures: NonNullable<ServiceOptions["requestPressures"]> = () => [
            {
                providerId: "openai",
                modelId: "probe-model",
                apiFormat: undefined,
                estimatedTextBytes: 1_000,
                estimatedMediaTokens: 0,
                actualInputTokens: 1_000,
            },
        ]

        await run(service(counted.frame, undefined, { requestPressures }), TWO_LARGE_TURNS)

        expect(countInputTokens).toHaveBeenCalled()
        expect(counted.calls).toHaveLength(1)
        const sent = JSON.stringify(counted.calls[0]?.[1])
        expect(sent).toContain("task A")
        expect(sent).toContain("task B")
    })

    // A Pass that cannot fit the window is refused before anything is sent:
    // sending it with a guessed budget only fails at the provider after paying
    // for the input.
    it("refuses a Pass that cannot fit the window without sending it", async () => {
        const { frame, calls } = probe([{ type: "text", text: SUMMARY_TEXT }], { contextWindow: 64, maxTokens: 64_000 })

        await expect(run(service(frame), { sourceHistory: SOURCE })).rejects.toThrow(/cannot fit in one compaction Pass/)
        expect(calls).toHaveLength(0)
    })

    it("refuses a conversation with no complete logical turn without sending it", async () => {
        const { frame, calls } = probe([{ type: "text", text: SUMMARY_TEXT }])

        await expect(run(service(frame), { sourceHistory: SOURCE.slice(0, 1) })).rejects.toThrow(
            "No complete logical turn is available for context compaction.",
        )
        expect(calls).toHaveLength(0)
    })

    // Guidance is never a turn of its own: the provider sees it inside the
    // compaction instruction, not as a block a model could answer by itself.
    it("folds the user's guidance into the instruction of this request only", async () => {
        const { frame, calls } = probe([{ type: "text", text: SUMMARY_TEXT }])

        await run(service(frame), { sourceHistory: SOURCE, guidance: " keep the audit " })

        const messages = calls[0]?.[1] as ClineStorageMessage[]
        // The source prefix is untouched, so the cache the ordinary request built still applies.
        expect(messages.slice(0, SOURCE.length)).toEqual(SOURCE)
        expect(messages[messages.length - 1]).toMatchObject({
            role: "user",
            content: [
                {
                    type: "text",
                    text: expect.stringMatching(
                        /^SUMMARIZE_INSTRUCTION:lite[\s\S]*\n\n<user_guidance>\nkeep the audit\n<\/user_guidance>$/,
                    ),
                },
            ],
        })
    })

    // Regenerate carries the user's latest word on the summary, so the
    // rejected request's guidance does not steer the next one.
    it("replaces the guidance with rejection feedback on a regenerated request", async () => {
        const { frame, calls } = probe([{ type: "text", text: SUMMARY_TEXT }])

        await run(service(frame), { sourceHistory: SOURCE, guidance: "keep the audit", feedback: "mention the tests" })

        const messages = calls[0]?.[1] as ClineStorageMessage[]
        expect(messages[messages.length - 1]?.content).toEqual([
            {
                type: "text",
                text: expect.stringMatching(
                    /^SUMMARIZE_INSTRUCTION:lite[\s\S]*\n\n<summary_feedback>\nmention the tests\n<\/summary_feedback>$/,
                ),
            },
        ])
    })

    it("sends the bare instruction when guidance and feedback are blank", async () => {
        const { frame, calls } = probe([{ type: "text", text: SUMMARY_TEXT }])

        await run(service(frame), { sourceHistory: SOURCE, guidance: "  ", feedback: "" })

        const messages = calls[0]?.[1] as ClineStorageMessage[]
        expect(messages[messages.length - 1]?.content).toEqual([
            { type: "text", text: expect.stringMatching(/^SUMMARIZE_INSTRUCTION:lite/) },
        ])
    })

    // The oldest turn alone did not fit with the next one, and once it was
    // summarized the conversation fit: the newer turn stays verbatim, so the
    // summary must land on the older turn only.
    it("stops after the oldest turns once the next request fits and reports where the summary ends", async () => {
        const { frame, calls } = probe([{ type: "text", text: SUMMARY_TEXT }], { contextWindow: 200_000, maxTokens: 64_000 })
        const source: ClineStorageMessage[] = [
            { role: "user", content: [{ type: "text", text: "task A" }] },
            { role: "assistant", content: [{ type: "text", text: "a".repeat(400_000) }] },
            { role: "user", content: [{ type: "text", text: "task B" }] },
            { role: "assistant", content: [{ type: "text", text: "b".repeat(400_000) }] },
        ]

        const result = await run(
            service(frame, () => ({ triggerPercent: 95 })),
            {
                sourceHistory: source,
                sourceRanges: [
                    [11, 11],
                    [12, 12],
                    [13, 13],
                    [14, 14],
                ],
            },
        )

        expect(calls).toHaveLength(1)
        expect(JSON.stringify(calls[0]?.[1])).toContain("task A")
        expect(JSON.stringify(calls[0]?.[1])).not.toContain("task B")
        expect(result).toEqual({ summary: "THE SUMMARY", coveredThrough: 12 })
    })

    it("measures the next request with the environment block it will carry, as dev does", async () => {
        const { frame, calls } = probe([{ type: "text", text: SUMMARY_TEXT }], { contextWindow: 200_000, maxTokens: 64_000 })
        const preview = vi.fn(async () => `<environment_details>${"e".repeat(400_000)}</environment_details>`)

        const result = await run(
            service(frame, () => ({ triggerPercent: 95 }), { environment: { preview } }),
            TWO_LARGE_TURNS,
        )

        // The kept turn plus the environment no longer fits, so a second Pass condenses it too.
        expect(calls).toHaveLength(2)
        expect(preview).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) })
        expect(result).toEqual({ summary: "THE SUMMARY", coveredThrough: 14 })
    })

    it("hands each accepted Pass's projected next request to the indicator", async () => {
        const { frame } = probe([{ type: "text", text: SUMMARY_TEXT }], { contextWindow: 200_000, maxTokens: 64_000 })
        const passProjected = vi.fn()

        await run(
            service(frame, () => ({ triggerPercent: 95 }), { indicator: { passProjected } }),
            TWO_LARGE_TURNS,
        )

        expect(passProjected).toHaveBeenCalledTimes(1)
        const [compactionId, projection] = passProjected.mock.calls[0] ?? []
        expect(compactionId).toBe("compaction:1")
        expect(projection).toMatchObject({ contextWindow: 200_000, environmentTokens: 0, pendingSendTokens: 0 })
        // The kept turn alone is about a quarter of the window; the full source was half of it.
        expect(projection.durableContextTokens).toBeGreaterThan(50_000)
        expect(projection.durableContextTokens).toBeLessThan(150_000)
    })

    it("requests the summary from the handler a run is bound to", async () => {
        const source = probe([{ type: "text", text: SUMMARY_TEXT }])
        const target = probe([{ type: "text", text: SUMMARY_TEXT }])
        const scopes = new CompactionRequestScopes()
        scopes.bind("compaction:1", { api: target.frame.api, mode: "plan" })
        const requested: unknown[] = []
        const bound = new ProviderCompactionService({
            frames: {
                frame: async (_signal, scope) => {
                    requested.push(scope)
                    return scope?.api === target.frame.api ? target.frame : source.frame
                },
            },
            instruction: () => "SUMMARIZE_INSTRUCTION",
            scopes,
        })

        await run(bound, { sourceHistory: SOURCE })

        // The transition's target condenses the context it has to fit; the
        // handler the task still runs on is never asked.
        expect(requested).toEqual([{ api: target.frame.api, mode: "plan" }])
        expect(target.calls).toHaveLength(1)
        expect(source.calls).toHaveLength(0)
    })

    it("uses the task's own frame for a run with no bound handler", async () => {
        const { frame, calls } = probe([{ type: "text", text: SUMMARY_TEXT }])
        const requested: unknown[] = []
        const unbound = new ProviderCompactionService({
            frames: {
                frame: async (_signal, scope) => {
                    requested.push(scope)
                    return frame
                },
            },
            instruction: () => "SUMMARIZE_INSTRUCTION",
            scopes: new CompactionRequestScopes(),
        })

        await run(unbound, { sourceHistory: SOURCE })

        expect(requested).toEqual([undefined])
        expect(calls).toHaveLength(1)
    })

    it("refuses a context that carries no source history", async () => {
        const { frame, calls } = probe([])

        await expect(run(service(frame), { mode: "summarize" })).rejects.toThrow("InvalidCompactionContext")
        expect(calls).toHaveLength(0)
    })
})
