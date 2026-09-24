import { PromptProfile } from "@core/prompts/profiles/types"
import type { ClineStorageMessage } from "@shared/messages/content"
import { describe, expect, it } from "vitest"
import type { ProviderRequestFrame } from "../../executors/provider/service/ProviderRequest"
import { CompactionRequestScopes } from "../CompactionRequestScopes"
import { ProviderCompactionService } from "../ProviderCompactionService"

const SOURCE: ClineStorageMessage[] = [{ role: "user", content: [{ type: "text", text: "original task" }] }]

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
			mode: "serial",
			profile: PromptProfile.Lite,
		},
	}
}

function service(
	frame: ProviderRequestFrame,
	triggerOptions?: ConstructorParameters<typeof ProviderCompactionService>[0]["triggerOptions"],
): ProviderCompactionService {
	return new ProviderCompactionService({
		frames: { frame: async () => frame },
		// The budget block is stated only when the window leaves output room, so
		// it is kept out of the instruction text these cases compare.
		instruction: (resolved, budget) => `SUMMARIZE_INSTRUCTION:${resolved.profile}${budget ? `\n${budget}` : ""}`,
		...(triggerOptions ? { triggerOptions } : {}),
	})
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

	it("falls back to a bounded budget without a zero hard limit when no room is measurable", async () => {
		const { frame, calls } = probe([{ type: "text", text: SUMMARY_TEXT }], { contextWindow: 64, maxTokens: 64_000 })

		await run(service(frame), { sourceHistory: SOURCE })

		expect(outputCap(calls)).toBe(30_000)
		expect(lastText(calls)).toBe("SUMMARIZE_INSTRUCTION:lite")
	})

	it("appends the user's guidance and rejection feedback to the instruction of this request only", async () => {
		const { frame, calls } = probe([{ type: "text", text: SUMMARY_TEXT }], { contextWindow: 64, maxTokens: 64_000 })

		await run(service(frame), { sourceHistory: SOURCE, guidance: " keep the audit ", feedback: "mention the tests" })

		const messages = calls[0]?.[1] as ClineStorageMessage[]
		// The source prefix is untouched, so the cache the ordinary request built still applies.
		expect(messages.slice(0, SOURCE.length)).toEqual(SOURCE)
		expect(messages[messages.length - 1]).toMatchObject({
			role: "user",
			content: [
				{
					type: "text",
					text: [
						"SUMMARIZE_INSTRUCTION:lite",
						"<user_guidance>\nkeep the audit\n</user_guidance>",
						"<summary_feedback>\nmention the tests\n</summary_feedback>",
					].join("\n\n"),
				},
			],
		})
	})

	it("sends the bare instruction when guidance and feedback are blank", async () => {
		const { frame, calls } = probe([{ type: "text", text: SUMMARY_TEXT }], { contextWindow: 64, maxTokens: 64_000 })

		await run(service(frame), { sourceHistory: SOURCE, guidance: "  ", feedback: "" })

		const messages = calls[0]?.[1] as ClineStorageMessage[]
		expect(messages[messages.length - 1]).toMatchObject({
			content: [{ type: "text", text: "SUMMARIZE_INSTRUCTION:lite" }],
		})
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
