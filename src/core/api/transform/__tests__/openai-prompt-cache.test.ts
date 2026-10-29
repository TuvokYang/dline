import { expect } from "chai"
import type OpenAI from "openai"
import { describe, it } from "vitest"
import { projectOpenAIChatPromptCache, projectOpenAIResponsesPromptCache } from "../openai-prompt-cache"

describe("OpenAI prompt cache projection", () => {
    it("uses automatic prompt caching by default without inferring explicit support from the model ID", () => {
        const projection = projectOpenAIChatPromptCache({
            modelId: "gpt-6",
            systemPrompt: "stable system",
            messages: [{ role: "developer", content: "stable system" }],
            tools: [],
        })

        expect(projection.promptCacheOptions).to.equal(undefined)
        expect(JSON.stringify(projection.messages)).not.to.contain("prompt_cache_breakpoint")
    })

    it("namespaces prompt cache keys with a 32-character stable identifier", () => {
        const chat = projectOpenAIChatPromptCache({
            modelId: "gpt-5.6-sol",
            systemPrompt: "stable system",
            messages: [{ role: "developer", content: "stable system" }],
            tools: [],
        })
        const responses = projectOpenAIResponsesPromptCache({
            modelId: "gpt-5.6-sol",
            systemPrompt: "stable system",
            input: [],
            tools: [],
        })

        expect(chat.promptCacheKey).to.match(/^dline_cache_[0-9a-f]{32}$/)
        expect(responses.promptCacheKey).to.match(/^dline_cache_[0-9a-f]{32}$/)
        expect(chat.promptCacheKey).to.have.length(44)
        expect(responses.promptCacheKey).to.have.length(44)
    })

    it("keeps cache keys stable within one Task namespace and isolates different Tasks", () => {
        const firstChat = projectOpenAIChatPromptCache({
            modelId: "gpt-5.6-sol",
            systemPrompt: "stable system",
            messages: [{ role: "user", content: "first turn" }],
            tools: [],
            taskNamespace: "task-a",
        })
        const appendedChat = projectOpenAIChatPromptCache({
            modelId: "gpt-5.6-sol",
            systemPrompt: "stable system",
            messages: [
                { role: "user", content: "first turn" },
                { role: "assistant", content: "response" },
                { role: "user", content: "second turn" },
            ],
            tools: [],
            taskNamespace: "task-a",
        })
        const otherTaskChat = projectOpenAIChatPromptCache({
            modelId: "gpt-5.6-sol",
            systemPrompt: "stable system",
            messages: [{ role: "user", content: "first turn" }],
            tools: [],
            taskNamespace: "task-b",
        })
        const firstResponses = projectOpenAIResponsesPromptCache({
            modelId: "gpt-5.6-sol",
            systemPrompt: "stable system",
            input: [{ role: "user", content: [{ type: "input_text", text: "first turn" }] }],
            tools: [],
            taskNamespace: "task-a",
        })
        const otherTaskResponses = projectOpenAIResponsesPromptCache({
            modelId: "gpt-5.6-sol",
            systemPrompt: "stable system",
            input: [{ role: "user", content: [{ type: "input_text", text: "first turn" }] }],
            tools: [],
            taskNamespace: "task-b",
        })

        expect(appendedChat.promptCacheKey).to.equal(firstChat.promptCacheKey)
        expect(otherTaskChat.promptCacheKey).not.to.equal(firstChat.promptCacheKey)
        expect(otherTaskResponses.promptCacheKey).not.to.equal(firstResponses.promptCacheKey)
    })

    it("keeps Chat keys stable across dynamic messages and changes them with tools", () => {
        const first = projectOpenAIChatPromptCache({
            modelId: "gpt-5.6-sol",
            systemPrompt: "stable system",
            messages: [
                { role: "developer", content: "stable system" },
                { role: "user", content: "dynamic A" },
            ],
            tools: [],
        })
        const second = projectOpenAIChatPromptCache({
            modelId: "gpt-5.6-sol",
            systemPrompt: "stable system",
            messages: [
                { role: "developer", content: "stable system" },
                { role: "user", content: "dynamic B" },
            ],
            tools: [],
        })
        const withTool = projectOpenAIChatPromptCache({
            modelId: "gpt-5.6-sol",
            systemPrompt: "stable system",
            messages: [{ role: "developer", content: "stable system" }],
            tools: [
                {
                    type: "function",
                    function: { name: "read_file", parameters: { type: "object" } },
                },
            ],
        })

        expect(second.promptCacheKey).to.equal(first.promptCacheKey)
        expect(withTool.promptCacheKey).not.to.equal(first.promptCacheKey)
        expect(second.messages.at(-1)).to.deep.include({ role: "user" })
    })

    it("projects explicit Chat controls only when the caller opts in", () => {
        const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
            { role: "developer", content: "stable system" },
            { role: "user", content: "one" },
            { role: "assistant", content: "two" },
            { role: "user", content: "three" },
            { role: "assistant", content: "four" },
            { role: "user", content: "five" },
        ]
        const original = structuredClone(messages)

        const projection = projectOpenAIChatPromptCache({
            modelId: "gpt-5.6-sol",
            systemPrompt: "stable system",
            messages,
            tools: [],
            mode: "explicit",
        })

        expect(messages).to.deep.equal(original)
        expect(projection.promptCacheOptions).to.deep.equal({ mode: "explicit" })
        expect(projection.promptCacheKey).to.be.a("string").and.not.equal("")
        expect(JSON.stringify(projection.messages[0])).to.contain("prompt_cache_breakpoint")
        for (const message of projection.messages.slice(1)) {
            expect(JSON.stringify(message)).not.to.contain("prompt_cache_breakpoint")
        }
    })

    it("keeps old Responses request semantics while adding a stable key", () => {
        const input: OpenAI.Responses.ResponseInput = [{ role: "user", content: [{ type: "input_text", text: "dynamic" }] }]
        const projection = projectOpenAIResponsesPromptCache({
            modelId: "gpt-5.5",
            systemPrompt: "stable system",
            input,
            tools: [],
        })

        expect(projection.instructions).to.equal("stable system")
        expect(projection.input).to.equal(input)
        expect(projection.promptCacheKey).to.be.a("string").and.not.equal("")
        expect(projection.promptCacheOptions).to.equal(undefined)
    })

    it("projects explicit Responses controls only when the caller opts in", () => {
        const input: OpenAI.Responses.ResponseInput = [{ role: "user", content: [{ type: "input_text", text: "dynamic" }] }]
        const original = structuredClone(input)
        const projection = projectOpenAIResponsesPromptCache({
            modelId: "gpt-5.6-sol",
            systemPrompt: "stable system",
            input,
            tools: [],
            mode: "explicit",
        })

        expect(input).to.deep.equal(original)
        expect(projection.instructions).to.equal(undefined)
        expect(projection.promptCacheOptions).to.deep.equal({ mode: "explicit" })
        expect(projection.promptCacheKey).to.be.a("string").and.not.equal("")
        expect(projection.input[0]).to.deep.equal({
            type: "message",
            role: "developer",
            content: [
                {
                    type: "input_text",
                    text: "stable system",
                    prompt_cache_breakpoint: { mode: "explicit" },
                },
            ],
        })
        expect(JSON.stringify(projection.input[1])).to.contain("dynamic")
    })

    it("shares cache routing keys across Chat and Responses for the same stable prefix", () => {
        const chat = projectOpenAIChatPromptCache({
            modelId: "gpt-5.6-sol",
            systemPrompt: "stable system",
            messages: [{ role: "developer", content: "stable system" }],
            tools: [],
        })
        const responses = projectOpenAIResponsesPromptCache({
            modelId: "gpt-5.6-sol",
            systemPrompt: "stable system",
            input: [],
            tools: [],
        })

        expect(chat.promptCacheKey).to.equal(responses.promptCacheKey)
    })
})
