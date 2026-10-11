import { estimateContextWindowCandidate } from "@core/context/context-management/context-window-projection"
import type { SystemPromptComposition } from "@core/prompts/generators/system-prompt-composition"
import {
    type ContextWindowIndicatorLineage,
    type DurableContextComposition,
    readDurableContextComposition,
    splitDurableContext,
} from "@shared/context-window-indicator"
import { describe, expect, it } from "vitest"
import { ContextWindowIndicator } from "../ContextWindowIndicator"
import { type ContextWindowRequestOpening, estimateDurableComposition } from "../ContextWindowIndicatorProjection"
import { readHistoryContextWindowIndicator } from "../HistoryContextWindow"
import { TaskContextUsageProjection } from "../session/TaskContextUsageProjection"

const SYSTEM_PROMPT = `${"base ".repeat(400)}${"rule ".repeat(200)}${"skill ".repeat(100)}${"flow ".repeat(100)}`
const PROMPT_COMPOSITION: SystemPromptComposition = {
    totalBytes: Buffer.byteLength(SYSTEM_PROMPT, "utf8"),
    userRulesBytes: 1000,
    skillsBytes: 600,
    workflowsBytes: 500,
    toolDefinitionsBytes: 0,
}
const TOOLS = [{ name: "read_file", description: "Read a file. ".repeat(50), input_schema: { type: "object" } }]
const PROVIDER_INPUT = {
    systemPrompt: SYSTEM_PROMPT,
    messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hello ".repeat(300) }] }],
    tools: TOOLS,
    serverTools: [],
}
const COMPOSITION: DurableContextComposition = {
    basePrompt: 400,
    userRules: 100,
    skills: 60,
    workflows: 40,
    toolDefinitions: 200,
}
const ORDINARY: ContextWindowIndicatorLineage = { kind: "ordinary", requestId: "r1", requestSequence: 1, attemptId: "r1" }
const NEXT: ContextWindowIndicatorLineage = { kind: "ordinary", requestId: "r2", requestSequence: 2, attemptId: "r2" }

function send(
    indicator: ContextWindowIndicator,
    lineage: ContextWindowIndicatorLineage,
    composition?: DurableContextComposition | null,
) {
    return indicator.beginSend({
        lineage,
        durableContextTokens: 1000,
        pendingSendTokens: 50,
        environmentTokens: 20,
        contextWindow: 10_000,
        mode: "act",
        ...(composition === undefined ? {} : { durableComposition: composition }),
    })
}

function createIndicator(): ContextWindowIndicator {
    return new ContextWindowIndicator({
        taskId: "task-1",
        durableContextTokens: 0,
        environmentTokens: 0,
        contextWindow: 10_000,
        mode: "act",
    })
}

describe("estimateDurableComposition", () => {
    it("splits the request prefix by source on the request's own estimate scale", () => {
        const composition = estimateDurableComposition({
            providerInput: PROVIDER_INPUT,
            systemPromptComposition: PROMPT_COMPOSITION,
        })
        const prefix = estimateContextWindowCandidate({ ...PROVIDER_INPUT, messages: [] })
        const prompt = estimateContextWindowCandidate({ systemPrompt: SYSTEM_PROMPT, messages: [] })

        expect(composition).toBeDefined()
        const parts = composition as DurableContextComposition
        expect(parts.basePrompt + parts.userRules + parts.skills + parts.workflows + parts.toolDefinitions).toBe(prefix)
        expect(parts.toolDefinitions).toBe(prefix - prompt)
        // Rules take 1000 of the prompt's bytes and skills 600, so their shares follow that order.
        expect(parts.userRules).toBeGreaterThan(parts.skills)
        expect(parts.skills).toBeGreaterThan(parts.workflows)
        expect(parts.basePrompt).toBeGreaterThan(parts.userRules)
    })

    it("ignores a composition that does not describe this exact prompt", () => {
        expect(
            estimateDurableComposition({
                providerInput: { ...PROVIDER_INPUT, systemPrompt: `${SYSTEM_PROMPT}changed` },
                systemPromptComposition: PROMPT_COMPOSITION,
            }),
        ).toBeUndefined()
        expect(estimateDurableComposition({ providerInput: PROVIDER_INPUT })).toBeUndefined()
    })
})

describe("splitDurableContext", () => {
    it("derives the conversation as what durable holds beyond the prefix", () => {
        expect(splitDurableContext(2000, COMPOSITION)).toEqual({ ...COMPOSITION, conversation: 1200 })
    })

    it("fits a prefix larger than durable without inventing conversation", () => {
        const split = splitDurableContext(400, COMPOSITION)
        const total = Object.values(split).reduce((sum, tokens) => sum + tokens, 0)

        expect(total).toBe(400)
        expect(split.conversation).toBe(0)
        expect(split.basePrompt).toBe(200)
        expect(split.toolDefinitions).toBe(100)
    })

    it("rejects a composition with any part that is not a whole token count", () => {
        expect(readDurableContextComposition(COMPOSITION)).toEqual(COMPOSITION)
        expect(readDurableContextComposition({ ...COMPOSITION, skills: -1 })).toBeUndefined()
        expect(readDurableContextComposition({ ...COMPOSITION, workflows: 1.5 })).toBeUndefined()
        const { userRules: _omitted, ...partial } = COMPOSITION
        expect(readDurableContextComposition(partial)).toBeUndefined()
    })
})

describe("ContextWindowIndicator durable composition", () => {
    it("adopts a measured request's split, keeps it through the round, and restores it on rollback", () => {
        const indicator = createIndicator()
        expect(send(indicator, ORDINARY, COMPOSITION).durableComposition).toEqual(COMPOSITION)

        indicator.receive({ lineage: ORDINARY, receivingTokens: 30, authoritativeContextTokens: 1100 })
        expect(indicator.settle({ lineage: ORDINARY }).durableComposition).toEqual(COMPOSITION)

        const larger = { ...COMPOSITION, userRules: 500 }
        expect(send(indicator, NEXT, larger).durableComposition).toEqual(larger)
        expect(indicator.rollback({ lineage: NEXT }).durableComposition).toEqual(COMPOSITION)
    })

    it("keeps the split for an unmeasured request and drops it for a measured one without a split", () => {
        const indicator = createIndicator()
        send(indicator, ORDINARY, COMPOSITION)
        expect(send(indicator, NEXT).durableComposition).toEqual(COMPOSITION)

        const dropped = send(indicator, { ...NEXT, requestId: "r3", attemptId: "r3", requestSequence: 3 }, null)
        expect(dropped.durableComposition).toBeUndefined()
        expect("durableComposition" in dropped).toBe(false)
    })

    it("keeps the prefix through a compaction commit, so only the conversation shrinks", () => {
        const indicator = createIndicator()
        send(indicator, ORDINARY, COMPOSITION)
        const rebased = indicator.rebaseDurable({
            durableContextTokens: 900,
            environmentTokens: 0,
            contextWindow: 10_000,
            mode: "act",
        })

        expect(rebased.durableComposition).toEqual(COMPOSITION)
        expect(splitDurableContext(rebased.durableContextTokens, COMPOSITION).conversation).toBe(100)
    })
})

describe("history and projection", () => {
    const stable = {
        taskId: "task-1",
        revision: 3,
        epoch: 2,
        phase: "stable",
        durableContextTokens: 1200,
        pendingSendTokens: 0,
        receivingTokens: 0,
        stagedTokens: 0,
        environmentTokens: 10,
        contextWindow: 10_000,
        mode: "act",
        updatedAt: 5,
        lineage: { kind: "baseline" },
    }

    it("restores a valid split with the figure and drops an invalid one without losing the figure", () => {
        expect(
            readHistoryContextWindowIndicator({ ...stable, durableComposition: COMPOSITION }, "task-1")?.durableComposition,
        ).toEqual(COMPOSITION)
        const invalid = readHistoryContextWindowIndicator({ ...stable, durableComposition: { basePrompt: "x" } }, "task-1")
        expect(invalid?.durableContextTokens).toBe(1200)
        expect(invalid?.durableComposition).toBeUndefined()
    })

    it("shows an opening's split on the scale of its projected occupancy", async () => {
        const target: { contextWindowIndicator?: ReturnType<ContextWindowIndicator["getSnapshot"]> } = {}
        const projection = new TaskContextUsageProjection({
            taskId: "task-1",
            target,
            scope: () => ({ mode: "act", contextWindow: 10_000 }),
            publish: async () => {},
        })
        const opening: ContextWindowRequestOpening = {
            estimatedTokens: 2000,
            projectedUsageTokens: 1000,
            segments: { durableContextTokens: 1500, pendingSendTokens: 400, environmentTokens: 100, totalTokens: 2000 },
            durableComposition: COMPOSITION,
        }

        await projection.started({ turnId: "r1", contextWindow: 10_000, opening })

        expect(target.contextWindowIndicator?.durableComposition).toEqual({
            basePrompt: 200,
            userRules: 50,
            skills: 30,
            workflows: 20,
            toolDefinitions: 100,
        })
    })
})
