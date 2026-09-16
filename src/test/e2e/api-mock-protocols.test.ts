import { expect } from "@playwright/test"
import OpenAI from "openai"
import { ToolCallProcessor } from "../../core/api/transform/tool-call-processor"
import type {
	MockApiConsumption,
	MockCacheDiagnostic,
	MockCacheWarning,
	MockCacheWarningCode,
	MockTokenUsage,
} from "./fixtures/server"
import { getE2EMockProviderBaseUrl, getE2EMockProviderUrl } from "./fixtures/server/api"
import { e2e } from "./utils/helpers"

function usageOf(consumption: MockApiConsumption): MockTokenUsage {
	if (!consumption.usage) throw new Error(`Missing usage for ${consumption.target}`)
	return consumption.usage
}

function totalInputTokens(usage: MockTokenUsage): number {
	return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
}

function cacheDiagnosticOf(consumption: MockApiConsumption): MockCacheDiagnostic {
	if (!consumption.cacheDiagnostic) throw new Error(`Missing cache diagnostic for ${consumption.target}`)
	return consumption.cacheDiagnostic
}

function cacheWarningsOf(
	server: { getCacheWarnings(target?: MockApiConsumption["target"]): readonly MockCacheWarning[] },
	target: MockApiConsumption["target"],
): readonly MockCacheWarning[] {
	return server.getCacheWarnings(target)
}

function expectDerivedUsage(consumption: MockApiConsumption, responseText: string, reasoning: string): MockTokenUsage {
	const usage = usageOf(consumption)
	const inputBytes = Buffer.byteLength(JSON.stringify(consumption.requestBody), "utf8")
	const outputBytes = Buffer.byteLength(`${reasoning}\n${responseText}`, "utf8")
	const measuredInput = totalInputTokens(usage)
	if (consumption.cacheDiagnostic) {
		const diagnostic = cacheDiagnosticOf(consumption)
		expect(measuredInput).toBe(diagnostic.totalInputTokens)
		expect(diagnostic.componentTokenEstimates.content).toBeGreaterThan(0)
		expect(usage.cacheWriteTokens ?? 0).toBeGreaterThan(0)
	} else {
		expect(measuredInput).toBe(Math.ceil(inputBytes / 4))
		expect(usage.cacheWriteTokens ?? 0).toBe(0)
	}
	expect(usage.outputTokens).toBeGreaterThanOrEqual(Math.ceil(outputBytes / 5))
	expect(usage.outputTokens).toBeLessThanOrEqual(Math.ceil(outputBytes / 3))
	expect(usage.inputTokens).toBeGreaterThan(0)
	expect(usage.cacheReadTokens).toBe(0)
	return usage
}

async function post(url: string, body: unknown, anthropic = false): Promise<Response> {
	return fetch(url, {
		method: "POST",
		headers: anthropic
			? { "content-type": "application/json", "x-api-key": "dline-e2e-api-key", "anthropic-version": "2023-06-01" }
			: { authorization: "Bearer dline-e2e-api-key", "content-type": "application/json" },
		body: JSON.stringify(body),
	})
}

e2e("Mock API - OpenAI SDK and Dline parser preserve standard streamed function calls", async ({ server }) => {
	server.resetOpenAiMock()
	server.enqueueResponses("openai-compatible-chat", {
		type: "tool",
		name: "read_file",
		arguments: { path: "README.md" },
	})
	const client = new OpenAI({
		apiKey: "dline-e2e-api-key",
		baseURL: getE2EMockProviderBaseUrl(server.baseUrl, "openai-compatible-chat"),
	})
	const stream = await client.chat.completions.create({
		model: "dline-e2e-model",
		stream: true,
		messages: [{ role: "user", content: "Read README.md" }],
		tools: [
			{
				type: "function",
				function: {
					name: "read_file",
					description: "Read a project file",
					parameters: {
						type: "object",
						properties: { path: { type: "string" } },
						required: ["path"],
					},
				},
			},
		],
	})

	const processor = new ToolCallProcessor()
	const parsedTools = []
	for await (const chunk of stream) {
		const delta = chunk.choices[0]?.delta
		parsedTools.push(...processor.processToolCallDeltas(delta?.tool_calls))
	}

	expect(parsedTools).toHaveLength(1)
	expect(parsedTools[0]).toMatchObject({
		type: "tool_calls",
		tool_call: {
			function: { name: "read_file", arguments: JSON.stringify({ path: "README.md" }) },
		},
	})
})

e2e("Mock API - emits parallel tool calls with stable identities for every protocol", async ({ server }) => {
	const tools = [
		{ id: "call_parallel_read", name: "read_file", arguments: { path: "README.md" } },
		{
			id: "call_parallel_write",
			name: "write_to_file",
			arguments: { path: "parallel-write.txt", content: "parallel write\n" },
		},
		{
			id: "call_parallel_replace",
			name: "replace_in_file",
			arguments: {
				path: "parallel-replace.txt",
				diff: "------- SEARCH\nbefore\n=======\nafter\n+++++++ REPLACE",
			},
		},
		{
			id: "call_parallel_command",
			name: "execute_command",
			arguments: { command: "echo parallel", workdirectory: ".", requires_approval: false },
		},
	] as const
	const targets = [
		"openai-compatible-chat",
		"openai-compatible-responses",
		"openai-official-responses",
		"deepseek-chat",
		"anthropic-messages",
	] as const
	server.resetOpenAiMock()
	for (const target of targets) server.enqueueResponses(target, { type: "tools", tools })

	const requests = [
		post(getE2EMockProviderUrl(server.baseUrl, "openai-compatible-chat"), {
			model: "dline-e2e-model",
			stream: true,
			messages: [{ role: "user", content: "parallel tools" }],
		}),
		post(getE2EMockProviderUrl(server.baseUrl, "openai-compatible-responses"), {
			model: "dline-e2e-model",
			stream: true,
			input: "parallel tools",
		}),
		post(getE2EMockProviderUrl(server.baseUrl, "openai-official-responses"), {
			model: "gpt-5.4-mini",
			stream: true,
			input: "parallel tools",
		}),
		post(getE2EMockProviderUrl(server.baseUrl, "deepseek-chat"), {
			model: "deepseek-v4-flash",
			stream: true,
			messages: [{ role: "user", content: "parallel tools" }],
		}),
		post(
			getE2EMockProviderUrl(server.baseUrl, "anthropic-messages"),
			{
				model: "claude-sonnet-4-6",
				max_tokens: 8192,
				stream: true,
				messages: [{ role: "user", content: "parallel tools" }],
			},
			true,
		),
	]
	const responses = await Promise.all(requests)

	for (const response of responses) {
		expect(response.status).toBe(200)
		const body = await response.text()
		for (const tool of tools) {
			expect(body).toContain(tool.id)
			expect(body).toContain(tool.name)
		}
	}
	for (const target of targets) {
		const [consumption] = server.getMockConsumptions(target)
		expect(consumption).toMatchObject({ responseType: "tools", responseToolCalls: tools })
	}
})

e2e("Mock API - isolates provider endpoints and emits protocol-native usage", async ({ server }) => {
	const responses = {
		chat: { text: "chat protocol response", hiddenReasoning: "chat protocol hidden reasoning" },
		compatible: {
			text: "compatible responses protocol response",
			reasoning: "compatible responses protocol thinking",
		},
		native: { text: "native responses protocol response", reasoning: "native responses protocol thinking" },
		deepseek: { text: "deepseek protocol response", reasoning: "deepseek reasoning content" },
		anthropic: { text: "anthropic protocol response", reasoning: "anthropic protocol thinking" },
	}
	server.resetOpenAiMock()
	server.enqueueResponses("openai-compatible-chat", {
		type: "message",
		text: responses.chat.text,
		hiddenReasoning: responses.chat.hiddenReasoning,
	})
	server.enqueueResponses("openai-compatible-responses", {
		type: "message",
		...responses.compatible,
	})
	server.enqueueResponses("openai-official-responses", {
		type: "message",
		...responses.native,
	})
	server.enqueueResponses("deepseek-chat", {
		type: "message",
		...responses.deepseek,
	})
	server.enqueueResponses("anthropic-messages", {
		type: "message",
		...responses.anthropic,
	})

	const chat = await post(getE2EMockProviderUrl(server.baseUrl, "openai-compatible-chat"), {
		model: "dline-e2e-model",
		stream: true,
		enable_thinking: true,
		reasoning_effort: "high",
		messages: [{ role: "user", content: "chat" }],
	})
	expect(chat.status).toBe(200)
	const chatBody = await chat.text()
	expect(chatBody).toContain(responses.chat.text)
	expect(chatBody).not.toContain(responses.chat.hiddenReasoning)

	const compatibleResponses = await post(getE2EMockProviderUrl(server.baseUrl, "openai-compatible-responses"), {
		model: "gpt-5.4-mini",
		stream: true,
		reasoning: { effort: "high", summary: "auto" },
		input: "responses",
	})
	expect(compatibleResponses.status).toBe(200)
	const compatibleResponsesBody = await compatibleResponses.text()
	expect(compatibleResponsesBody).toContain("response.output_text.delta")
	expect(compatibleResponsesBody).toContain(responses.compatible.text)
	expect(compatibleResponsesBody).toContain(responses.compatible.reasoning)

	const officialResponses = await post(getE2EMockProviderUrl(server.baseUrl, "openai-official-responses"), {
		model: "gpt-5.4-mini",
		stream: true,
		reasoning: { effort: "high", summary: "auto" },
		input: "responses",
	})
	expect(officialResponses.status).toBe(200)
	const officialResponsesBody = await officialResponses.text()
	expect(officialResponsesBody).toContain(responses.native.text)
	expect(officialResponsesBody).toContain(responses.native.reasoning)

	const deepseek = await post(getE2EMockProviderUrl(server.baseUrl, "deepseek-chat"), {
		model: "deepseek-v4-flash",
		stream: true,
		thinking: { type: "enabled" },
		reasoning_effort: "high",
		messages: [{ role: "user", content: "deepseek" }],
	})
	expect(deepseek.status).toBe(200)
	const deepseekBody = await deepseek.text()
	expect(deepseekBody).toContain(responses.deepseek.text)
	expect(deepseekBody).toContain(`"reasoning_content":"${responses.deepseek.reasoning}"`)

	const anthropic = await post(
		getE2EMockProviderUrl(server.baseUrl, "anthropic-messages"),
		{
			model: "claude-sonnet-4-6",
			max_tokens: 8192,
			stream: true,
			thinking: { type: "enabled", budget_tokens: 2048 },
			messages: [{ role: "user", content: "anthropic" }],
		},
		true,
	)
	expect(anthropic.status).toBe(200)
	const anthropicBody = await anthropic.text()
	expect(anthropicBody).toContain("content_block_delta")
	expect(anthropicBody).toContain(responses.anthropic.text)
	expect(anthropicBody).toContain(responses.anthropic.reasoning)

	expect(server.getRequestCount("openai-compatible-chat")).toBe(1)
	expect(server.getRequestCount("openai-compatible-responses")).toBe(1)
	expect(server.getRequestCount("openai-official-responses")).toBe(1)
	expect(server.getRequestCount("deepseek-chat")).toBe(1)
	expect(server.getRequestCount("anthropic-messages")).toBe(1)
	const consumptions = server.getMockConsumptions()
	expect(consumptions.map(({ target, thinking }) => ({ target, thinking }))).toEqual([
		{ target: "openai-compatible-chat", thinking: { mode: "effort", effort: "high" } },
		{ target: "openai-compatible-responses", thinking: { mode: "effort", effort: "high" } },
		{ target: "openai-official-responses", thinking: { mode: "effort", effort: "high" } },
		{ target: "deepseek-chat", thinking: { mode: "effort", effort: "high" } },
		{ target: "anthropic-messages", thinking: { mode: "budget", budget: 2048 } },
	])
	const chatUsage = expectDerivedUsage(consumptions[0], responses.chat.text, responses.chat.hiddenReasoning)
	const compatibleUsage = expectDerivedUsage(consumptions[1], responses.compatible.text, responses.compatible.reasoning)
	const nativeUsage = expectDerivedUsage(consumptions[2], responses.native.text, responses.native.reasoning)
	const deepseekUsage = expectDerivedUsage(consumptions[3], responses.deepseek.text, responses.deepseek.reasoning)
	const anthropicUsage = expectDerivedUsage(consumptions[4], responses.anthropic.text, responses.anthropic.reasoning)

	for (const [body, usage, inputKey] of [
		[chatBody, chatUsage, "prompt_tokens"],
		[compatibleResponsesBody, compatibleUsage, "input_tokens"],
		[officialResponsesBody, nativeUsage, "input_tokens"],
		[deepseekBody, deepseekUsage, "prompt_tokens"],
	] as const) {
		expect(body).toContain(`"${inputKey}":${totalInputTokens(usage)}`)
		expect(body).toContain(`"cached_tokens":${usage.cacheReadTokens ?? 0}`)
		expect(body).toContain(`"cache_miss_tokens":${usage.cacheWriteTokens ?? 0}`)
	}
	expect(chatBody).toContain(`"completion_tokens":${chatUsage.outputTokens}`)
	expect(chatBody).toContain(`"reasoning_tokens":${chatUsage.reasoningTokens}`)
	expect(compatibleResponsesBody).toContain(`"output_tokens":${compatibleUsage.outputTokens}`)
	expect(officialResponsesBody).toContain(`"output_tokens":${nativeUsage.outputTokens}`)
	expect(deepseekBody).toContain(`"completion_tokens":${deepseekUsage.outputTokens}`)
	expect(deepseekBody).toContain(`"prompt_cache_hit_tokens":${deepseekUsage.cacheReadTokens ?? 0}`)
	expect(deepseekBody).toContain(`"prompt_cache_miss_tokens":${deepseekUsage.cacheWriteTokens ?? 0}`)
	expect(anthropicBody).toContain(`"input_tokens":${anthropicUsage.inputTokens}`)
	expect(anthropicBody).toContain(`"output_tokens":${anthropicUsage.outputTokens}`)
	expect(anthropicBody).toContain(`"cache_creation_input_tokens":${anthropicUsage.cacheWriteTokens ?? 0}`)
	expect(anthropicBody).toContain(`"cache_read_input_tokens":${anthropicUsage.cacheReadTokens ?? 0}`)
})

e2e("Mock API - tracks growing OpenAI prompt prefixes without false cache warnings", async ({ server }) => {
	const target = "openai-official-responses" as const
	const stableInstructions = "Stable system instructions for OpenAI prompt cache diagnostics. ".repeat(12)
	const stableTools = [
		{
			type: "function",
			name: "read_file",
			description: "Read one project file without changing the workspace.",
			parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
		},
	]
	const turns = [
		[{ role: "user", content: `FIRST_TURN_${"a".repeat(640)}` }],
		[
			{ role: "user", content: `FIRST_TURN_${"a".repeat(640)}` },
			{ role: "assistant", content: `FIRST_REPLY_${"b".repeat(320)}` },
			{ role: "user", content: `SECOND_TURN_${"c".repeat(480)}` },
		],
		[
			{ role: "user", content: `FIRST_TURN_${"a".repeat(640)}` },
			{ role: "assistant", content: `FIRST_REPLY_${"b".repeat(320)}` },
			{ role: "user", content: `SECOND_TURN_${"c".repeat(480)}` },
			{ role: "assistant", content: `SECOND_REPLY_${"d".repeat(320)}` },
			{ role: "user", content: `THIRD_TURN_${"e".repeat(480)}` },
		],
	]

	server.resetOpenAiMock()
	server.enqueueResponses(
		target,
		{ type: "message", text: "first" },
		{ type: "message", text: "second" },
		{ type: "message", text: "third" },
	)
	for (const input of turns) {
		const response = await post(getE2EMockProviderUrl(server.baseUrl, target), {
			model: "gpt-5.4-mini",
			prompt_cache_key: "stable-task-cache-key",
			instructions: stableInstructions,
			tools: stableTools,
			input,
			stream: true,
			store: false,
		})
		expect(response.status).toBe(200)
		await response.text()
	}

	const diagnostics = server.getMockConsumptions(target).map(cacheDiagnosticOf)
	expect(diagnostics.map(({ state }) => state)).toEqual(["cold", "warm", "warm"])
	expect(diagnostics[0].cacheReadTokens).toBe(0)
	expect(diagnostics[1].cacheReadTokens).toBeGreaterThan(0)
	expect(diagnostics[2].cacheReadTokens).toBeGreaterThan(diagnostics[1].cacheReadTokens)
	expect(diagnostics[2].reusablePrefixTokens).toBeGreaterThan(diagnostics[1].reusablePrefixTokens)
	expect(diagnostics[0].stablePrefixTokens).toBeGreaterThan(0)
	for (const diagnostic of diagnostics.slice(1)) {
		expect(diagnostic.prefixHashMatched).toBe(true)
		expect(diagnostic.expectedPrefixHash).toBe(diagnostic.actualPrefixHash)
		expect(diagnostic.componentHashes.system).toBe(diagnostics[0].componentHashes.system)
		expect(diagnostic.componentHashes.tools).toBe(diagnostics[0].componentHashes.tools)
	}
	expect(cacheWarningsOf(server, target)).toEqual([])
})

e2e("Mock API - keeps multi-tool prompt caching across temporary reasoning and service tier changes", async ({ server }) => {
	const target = "openai-compatible-responses" as const
	const promptCacheKey = "runtime-overrides-multi-tool-cache-key"
	const instructions =
		"Inspect every adjacent request without changing the frozen system instructions or native tool declarations."
	const tools = [
		{
			type: "function",
			name: "read_file",
			description: "Read one project file.",
			parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
		},
		{
			type: "function",
			name: "search_files",
			description: "Search project files for a focused expression.",
			parameters: {
				type: "object",
				properties: { path: { type: "string" }, regex: { type: "string" } },
				required: ["path", "regex"],
			},
		},
	]
	const firstInput = [
		{
			type: "message",
			role: "user",
			content: [{ type: "input_text", text: "Inspect the runtime override and prompt-cache boundaries." }],
		},
	]
	const secondInput = [
		...firstInput,
		{
			type: "function_call",
			call_id: "call_read_runtime_1",
			name: "read_file",
			arguments: '{"path":"src/core/api/runtime-profile.ts"}',
		},
		{
			type: "function_call",
			call_id: "call_search_runtime_1",
			name: "search_files",
			arguments: '{"path":"src/core","regex":"serviceTier|reasoning"}',
		},
		{ type: "function_call_output", call_id: "call_read_runtime_1", output: "Runtime overrides clone the Profile." },
		{
			type: "function_call_output",
			call_id: "call_search_runtime_1",
			output: "Request options remain outside prompt content.",
		},
		{
			type: "message",
			role: "user",
			content: [{ type: "input_text", text: "Switch temporarily to low reasoning and ultrafast service." }],
		},
	]
	const thirdInput = [
		...secondInput,
		{
			type: "function_call",
			call_id: "call_read_runtime_2",
			name: "read_file",
			arguments: '{"path":"src/core/api/providers/openai.ts"}',
		},
		{
			type: "function_call",
			call_id: "call_search_runtime_2",
			name: "search_files",
			arguments: '{"path":"src/test/e2e","regex":"cacheDiagnostic"}',
		},
		{
			type: "function_call_output",
			call_id: "call_read_runtime_2",
			output: "The prompt cache key excludes request scheduling controls.",
		},
		{
			type: "function_call_output",
			call_id: "call_search_runtime_2",
			output: "The diagnostic compares semantic prompt prefixes.",
		},
		{
			type: "message",
			role: "user",
			content: [{ type: "input_text", text: "Switch again while preserving both completed multi-tool rounds." }],
		},
	]

	server.resetOpenAiMock()
	server.enqueueResponses(
		target,
		{
			type: "tools",
			tools: [
				{ id: "call_read_runtime_1", name: "read_file", arguments: { path: "src/core/api/runtime-profile.ts" } },
				{
					id: "call_search_runtime_1",
					name: "search_files",
					arguments: { path: "src/core", regex: "serviceTier|reasoning" },
				},
			],
		},
		{
			type: "tools",
			tools: [
				{ id: "call_read_runtime_2", name: "read_file", arguments: { path: "src/core/api/providers/openai.ts" } },
				{
					id: "call_search_runtime_2",
					name: "search_files",
					arguments: { path: "src/test/e2e", regex: "cacheDiagnostic" },
				},
			],
		},
		{ type: "message", text: "Runtime override cache continuity verified." },
	)
	const requests = [
		{ input: firstInput, reasoning: { effort: "high" }, service_tier: "default" },
		{ input: secondInput, reasoning: { effort: "low" }, service_tier: "ultrafast" },
		{ input: thirdInput, reasoning: { effort: "medium" }, service_tier: "flex" },
	]
	for (const request of requests) {
		const response = await post(getE2EMockProviderUrl(server.baseUrl, target), {
			model: "gpt-5.6-sol",
			prompt_cache_key: promptCacheKey,
			instructions,
			tools,
			...request,
			stream: true,
			store: false,
		})
		expect(response.status).toBe(200)
		await response.text()
	}

	const consumptions = server.getMockConsumptions(target)
	expect(consumptions.map(({ responseType }) => responseType)).toEqual(["tools", "tools", "message"])
	expect(consumptions.slice(0, 2).map(({ responseToolCalls }) => responseToolCalls?.length)).toEqual([2, 2])
	const diagnostics = consumptions.map(cacheDiagnosticOf)
	expect(diagnostics.map(({ state }) => state)).toEqual(["cold", "warm", "warm"])
	expect(diagnostics[1].cacheReadTokens).toBeGreaterThan(0)
	expect(diagnostics[2].cacheReadTokens).toBeGreaterThan(diagnostics[1].cacheReadTokens)
	for (const diagnostic of diagnostics.slice(1)) {
		expect(diagnostic.prefixHashMatched).toBe(true)
		expect(diagnostic.actualPrefixHash).toBe(diagnostics[0].actualPrefixHash)
	}
	expect(cacheWarningsOf(server, target)).toEqual([])
})

e2e("Mock API - reports the first semantic OpenAI prompt divergence with complete E2E text", async ({ server }) => {
	const target = "openai-compatible-responses" as const
	const instructions =
		"You are reviewing a production incident. Preserve the established architecture, distinguish confirmed evidence from hypotheses, and report the earliest request-field change that could invalidate a continuous prompt-cache prefix."
	const tools = [
		{
			type: "function",
			name: "read_file",
			description: "Read a project file so the investigation can cite the exact implementation boundary.",
			parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
		},
	]
	const inputs = [
		[
			{
				role: "user",
				content:
					"The first request asks for a careful comparison of two adjacent provider payloads, including the stable system instructions, ordered conversation history, and ordered native tool declarations.",
			},
		],
		[
			{
				role: "user",
				content:
					"The second request asks for a careful comparison of two adjacent provider payloads, including the stable system instructions, ordered conversation history, and ordered native tool declarations.",
			},
		],
	]

	server.resetOpenAiMock()
	server.enqueueResponses(
		target,
		{ type: "message", text: "first diagnostic response" },
		{ type: "message", text: "second diagnostic response" },
	)
	for (const input of inputs) {
		const response = await post(getE2EMockProviderUrl(server.baseUrl, target), {
			model: "gpt-5.4-mini",
			prompt_cache_key: "semantic-divergence-task-cache-key",
			instructions,
			tools,
			input,
			stream: true,
			store: false,
		})
		expect(response.status).toBe(200)
		await response.text()
	}

	const diagnostic = cacheDiagnosticOf(server.getMockConsumptions(target)[1]) as MockCacheDiagnostic & {
		firstDivergence?: {
			component: string
			path: string
			byteOffset: number
			estimatedTokenOffset: number
			beforeHash: string
			afterHash: string
		}
		projection?: { mode: string }
	}
	expect(diagnostic.firstDivergence).toMatchObject({
		component: "input",
		path: "input[0].content",
	})
	expect(diagnostic.firstDivergence?.byteOffset).toBeGreaterThan(0)
	expect(diagnostic.firstDivergence?.estimatedTokenOffset).toBeGreaterThan(0)
	expect(diagnostic.firstDivergence?.beforeHash).toMatch(/^[0-9a-f]{16}$/)
	expect(diagnostic.firstDivergence?.afterHash).toMatch(/^[0-9a-f]{16}$/)
	expect(diagnostic.firstDivergence?.beforeText).toContain(inputs[0][0].content)
	expect(diagnostic.firstDivergence?.afterText).toContain(inputs[1][0].content)
	expect(diagnostic.prefixHashMatched).toBe(true)
	expect(diagnostic.expectedPrefixHash).toBe(diagnostic.actualPrefixHash)
	expect(diagnostic.projection).toMatchObject({ mode: "automatic" })
	const reportText = JSON.stringify(server.getCacheDiagnosticReport())
	expect(reportText).toContain(inputs[0][0].content)
	expect(reportText).toContain(inputs[1][0].content)
})

e2e("Mock API - detects an exact OpenAI system/tools prefix hash replacement", async ({ server }) => {
	const target = "openai-compatible-responses" as const
	const firstInstructions = "E2E_PREFIX_HASH_SYSTEM_ALPHA includes Rules, Skills, Workflows, and MCP catalog entries."
	const secondInstructions = "E2E_PREFIX_HASH_SYSTEM_BETA replaces one frozen system field unexpectedly."
	const tools = [
		{
			type: "function",
			name: "read_file",
			description: "E2E_PREFIX_HASH_TOOL reads a project file.",
			parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
		},
	]

	server.resetOpenAiMock()
	server.enqueueResponses(target, { type: "message", text: "first" }, { type: "message", text: "second" })
	for (const instructions of [firstInstructions, secondInstructions]) {
		const response = await post(getE2EMockProviderUrl(server.baseUrl, target), {
			model: "gpt-5.6-sol",
			prompt_cache_key: "exact-prefix-hash-task",
			instructions,
			tools,
			input: [{ role: "user", content: "E2E_PREFIX_HASH_CONTENT" }],
			stream: true,
			store: false,
		})
		expect(response.status).toBe(200)
		await response.text()
	}

	const diagnostics = server.getMockConsumptions(target).map(cacheDiagnosticOf)
	expect(diagnostics[1].state).toBe("prefix_mismatch")
	expect(diagnostics[1].prefixHashMatched).toBe(false)
	expect(diagnostics[1].expectedPrefixHash).not.toBe(diagnostics[1].actualPrefixHash)
	expect(diagnostics[1].warnings.map(({ code }) => code)).toContain("prefix_hash_mismatch")
	expect(diagnostics[1].firstDivergence).toMatchObject({
		component: "instructions",
		path: "instructions",
	})
	expect(diagnostics[1].firstDivergence?.beforeText).toContain(firstInstructions)
	expect(diagnostics[1].firstDivergence?.afterText).toContain(secondInstructions)
	const reportText = JSON.stringify(server.getCacheDiagnosticReport())
	expect(reportText).toContain(firstInstructions)
	expect(reportText).toContain(secondInstructions)
	expect(reportText).toContain("E2E_PREFIX_HASH_TOOL")
})

e2e("Mock API - warns when reported OpenAI cache reads plateau while the prompt keeps growing", async ({ server }) => {
	const target = "openai-official-responses" as const
	const usages: MockTokenUsage[] = [
		{ inputTokens: 240, outputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 160 },
		{ inputTokens: 280, outputTokens: 8, cacheReadTokens: 120, cacheWriteTokens: 120 },
		{ inputTokens: 400, outputTokens: 8, cacheReadTokens: 120, cacheWriteTokens: 120 },
		{ inputTokens: 520, outputTokens: 8, cacheReadTokens: 120, cacheWriteTokens: 120 },
	]
	const stablePrefix = { role: "user", content: `STABLE_PREFIX_${"p".repeat(720)}` }

	server.resetOpenAiMock()
	server.enqueueResponses(
		target,
		...usages.map((usage, index) => ({ type: "message" as const, text: `response-${index}`, usage })),
	)
	for (let index = 0; index < usages.length; index++) {
		const input = [
			stablePrefix,
			...Array.from({ length: index + 1 }, (_, turn) => ({
				role: turn % 2 === 0 ? "assistant" : "user",
				content: `GROWING_TURN_${turn}_${"x".repeat(480)}`,
			})),
		]
		const response = await post(getE2EMockProviderUrl(server.baseUrl, target), {
			model: "gpt-5.4-mini",
			prompt_cache_key: "plateau-task-cache-key",
			instructions: "Stable plateau diagnostic instructions.",
			input,
			stream: true,
			store: false,
		})
		expect(response.status).toBe(200)
		await response.text()
	}

	const diagnostics = server.getMockConsumptions(target).map(cacheDiagnosticOf)
	expect(diagnostics.map(({ totalInputTokens }) => totalInputTokens)).toEqual(usages.map(totalInputTokens))
	expect(diagnostics.at(-1)?.state).toBe("plateau")
	expect(cacheWarningsOf(server, target).map(({ code }) => code)).toContain("cache_plateau")
})

e2e("Mock API - distinguishes OpenAI cache identity drift, prefix regression, and a warm miss", async ({ server }) => {
	const target = "openai-compatible-responses" as const
	const stableHead = { role: "user", content: `STABLE_HEAD_${"s".repeat(800)}` }
	const requests = [
		{
			include: ["reasoning.encrypted_content"],
			input: [stableHead],
			usage: { inputTokens: 180, outputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 120 },
		},
		{
			include: ["reasoning.encrypted_content"],
			input: [stableHead, { role: "user", content: `WARM_SUFFIX_${"w".repeat(640)}` }],
			usage: { inputTokens: 160, outputTokens: 8, cacheReadTokens: 240, cacheWriteTokens: 80 },
		},
		{
			include: ["reasoning.encrypted_content"],
			input: [{ role: "user", content: `CHANGED_EARLY_PREFIX_${"z".repeat(640)}` }],
			usage: { inputTokens: 360, outputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 120 },
		},
		{
			include: ["reasoning.encrypted_content", "web_search_call.results"],
			input: [{ role: "user", content: `CHANGED_EARLY_PREFIX_${"z".repeat(640)}` }],
			usage: { inputTokens: 280, outputTokens: 8, cacheReadTokens: 120, cacheWriteTokens: 80 },
		},
	]

	server.resetOpenAiMock()
	server.enqueueResponses(
		target,
		...requests.map(({ usage }, index) => ({ type: "message" as const, text: `response-${index}`, usage })),
	)
	for (const request of requests) {
		const response = await post(getE2EMockProviderUrl(server.baseUrl, target), {
			model: "gpt-5.4-mini",
			prompt_cache_key: "identity-task-cache-key",
			instructions: "Stable identity diagnostic instructions.",
			input: request.input,
			include: request.include,
			stream: true,
			store: false,
		})
		expect(response.status).toBe(200)
		await response.text()
	}

	const diagnostics = server.getMockConsumptions(target).map(cacheDiagnosticOf)
	const expectedWarningCodes: MockCacheWarningCode[] = ["prefix_regression", "warm_cache_miss"]
	expect(diagnostics[2].warnings.map(({ code }) => code)).toEqual(expect.arrayContaining(expectedWarningCodes))
	expect(diagnostics[3].warnings.map(({ code }) => code)).toContain("identity_changed")
	expect(new Set(diagnostics.map(({ identity }) => identity)).size).toBe(2)
})

e2e("Mock API - scripts 403, 429, and 502 responses and records their consumption", async ({ server }) => {
	server.resetOpenAiMock()
	server.enqueueResponses(
		"openai-compatible-chat",
		{ type: "error", status: 403, code: "forbidden", message: "E2E_HTTP_403" },
		{ type: "error", status: 429, code: "rate_limit", message: "E2E_HTTP_429" },
		{ type: "error", status: 502, code: "bad_gateway", message: "E2E_HTTP_502" },
	)

	for (const status of [403, 429, 502]) {
		const response = await post(getE2EMockProviderUrl(server.baseUrl, "openai-compatible-chat"), {
			model: "dline-e2e-model",
			stream: true,
			messages: [{ role: "user", content: "error" }],
		})
		expect(response.status).toBe(status)
		expect(await response.text()).toContain(`E2E_HTTP_${status}`)
	}

	expect(server.getMockConsumptions("openai-compatible-chat").map((entry) => entry.status)).toEqual([403, 429, 502])
})

e2e("Mock API - rejects a scripted response when the required tool result contract is not met", async ({ server }) => {
	server.resetOpenAiMock()
	server.enqueueResponses("openai-compatible-chat", {
		type: "message",
		text: "This response must not be emitted",
		expectedToolResults: [{ callId: "call_required", contentIncludes: "EXPECTED_RESULT_MARKER" }],
	})

	const response = await post(getE2EMockProviderUrl(server.baseUrl, "openai-compatible-chat"), {
		model: "dline-e2e-model",
		stream: true,
		messages: [
			{ role: "assistant", tool_calls: [{ id: "call_required", type: "function" }] },
			{ role: "tool", tool_call_id: "call_required", content: "WRONG_RESULT_MARKER" },
		],
	})

	expect(response.status).toBe(500)
	const body = await response.text()
	expect(body).toContain("e2e_tool_result_contract_failed")
	expect(body).toContain("EXPECTED_RESULT_MARKER")
	const consumptions = server.getMockConsumptions("openai-compatible-chat")
	expect(consumptions).toHaveLength(1)
	expect(consumptions[0].requestToolResults).toEqual([{ callId: "call_required", content: "WRONG_RESULT_MARKER" }])
	expect(consumptions[0].contractError).toContain("EXPECTED_RESULT_MARKER")
})

e2e("Mock API - rejects provider-incompatible authentication and request shapes", async ({ server }) => {
	server.resetOpenAiMock()

	const anthropicWithBearer = await post(getE2EMockProviderUrl(server.baseUrl, "anthropic-messages"), {
		model: "claude-sonnet-4-6",
		max_tokens: 128,
		messages: [{ role: "user", content: "test" }],
	})
	expect(anthropicWithBearer.status).toBe(401)

	const openAiWithAnthropicHeaders = await post(
		getE2EMockProviderUrl(server.baseUrl, "openai-compatible-chat"),
		{ model: "dline-e2e-model", messages: [{ role: "user", content: "test" }] },
		true,
	)
	expect(openAiWithAnthropicHeaders.status).toBe(401)

	const chatBodyOnResponsesEndpoint = await post(getE2EMockProviderUrl(server.baseUrl, "openai-compatible-responses"), {
		model: "dline-e2e-model",
		messages: [{ role: "user", content: "test" }],
	})
	expect(chatBodyOnResponsesEndpoint.status).toBe(400)
	expect(server.getMockConsumptions()).toHaveLength(0)
})
