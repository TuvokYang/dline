import { Mistral } from "@mistralai/mistralai"
import { HTTPClient } from "@mistralai/mistralai/lib/http"
import { Tool as MistralTool } from "@mistralai/mistralai/models/components/tool"
import { MistralModelId, ModelInfo, mistralDefaultModelId, mistralModels } from "@shared/api"
import { resolveForcedToolUseSupport } from "@shared/utils/reasoning-support"
import type { ChatCompletionTool as OpenAITool } from "openai/resources/chat/completions"
import { buildExternalBasicHeaders } from "@/services/EnvUtils"
import { ClineStorageMessage } from "@/shared/messages/content"
import { providerFetch } from "@/shared/net"
import { ApiHandler, ApiHandlerContext } from "../"
import { withRetry } from "../retry"
import { convertToMistralMessages } from "../transform/mistral-format"
import { ApiStream } from "../transform/stream"

export class MistralHandler implements ApiHandler {
	private client: Mistral | undefined

	constructor(private ctx: ApiHandlerContext) {}

	private get config() {
		return this.ctx.profile.mistral
	}
	private get apiKey() {
		return this.ctx.profile.apiKey
	}
	private get modelId() {
		return this.ctx.profile.modelId || ""
	}
	private get modelInfo() {
		return this.ctx.profile.modelInfo as ModelInfo | undefined
	}
	private get baseUrl() {
		return this.ctx.profile.baseUrl
	}

	private ensureClient(): Mistral {
		if (!this.client) {
			if (!this.apiKey) {
				throw new Error("Mistral API key is required")
			}
			try {
				const externalHeaders = buildExternalBasicHeaders()
				// Create HTTP client with custom fetch for proxy support
				// The Mistral SDK's HTTPClient passes a Request object to the fetcher,
				// but we need to extract the URL and init options to pass to our fetch wrapper
				// which properly handles proxy configuration in standalone mode (JetBrains/CLI)
				const httpClient = new HTTPClient({
					fetcher: async (input: RequestInfo | URL, init?: RequestInit) => {
						// Handle both string/URL and Request object inputs
						if (input instanceof Request) {
							Object.keys(externalHeaders).forEach((key) => {
								if (!input.headers.has(key)) {
									input.headers.set(key, externalHeaders[key])
								}
							})
							return providerFetch(input.url, {
								method: input.method,
								headers: input.headers,
								body: input.body,
								redirect: input.redirect,
								signal: input.signal,
								// duplex is required when sending a body stream in Node.js/undici
								duplex: input.body ? "half" : undefined,
								...init,
							} as RequestInit)
						}

						// Merge external headers with existing headers
						const mergedInit = {
							...init,
							headers: {
								...externalHeaders,
								...(init?.headers || {}),
							},
						}
						return providerFetch(input, mergedInit)
					},
				})

				this.client = new Mistral({
					apiKey: this.apiKey,
					httpClient,
				})
			} catch (error) {
				throw new Error(`Error creating Mistral client: ${error.message}`)
			}
		}
		return this.client
	}

	@withRetry()
	async *createMessage(systemPrompt: string, messages: ClineStorageMessage[], tools?: OpenAITool[]): ApiStream {
		const client = this.ensureClient()
		const model = this.getModel()
		const nativeToolsOn = (tools?.length ?? 0) > 0
		// A model that rejects a forced choice fails the whole request rather than
		// degrading to an automatic one.
		const forcedToolUseOn = resolveForcedToolUseSupport(model.id, model.info.capabilities)
		const stream = await client.chat
			.stream({
				model: model.id,
				// max_completion_tokens: this.getModel().info.capabilities?.maxTokens,
				temperature: 0,
				messages: [{ role: "system", content: systemPrompt }, ...convertToMistralMessages(messages)],
				stream: true,
				tools: nativeToolsOn ? (tools as MistralTool[]) : undefined,
				toolChoice: nativeToolsOn ? (forcedToolUseOn ? "any" : "auto") : undefined,
			})
			.catch((err) => {
				// The Mistal SDK uses statusCode instead of status
				// However, if they introduce status for something, I don't want to override it
				if ("statusCode" in err && !("status" in err)) {
					err.status = err.statusCode
				}

				throw err
			})

		for await (const chunk of stream) {
			const delta = chunk.data.choices[0]?.delta
			if (delta.toolCalls) {
				for (const toolCall of delta.toolCalls) {
					if (!toolCall.id) throw new Error("Mistral tool call is missing function identity")
					yield {
						type: "tool_calls",
						function_id: toolCall.id,
						argumentsMode: "snapshot",
						tool_call: {
							function: {
								name: toolCall.function.name,
								arguments: JSON.stringify(toolCall.function.arguments),
							},
						},
					}
				}
			} else if (delta?.content) {
				let content = ""
				if (typeof delta.content === "string") {
					content = delta.content
				} else if (Array.isArray(delta.content)) {
					content = delta.content.map((c) => (c.type === "text" ? c.text : "")).join("")
				}
				yield {
					type: "text",
					text: content,
				}
			}

			if (chunk.data.usage) {
				yield {
					type: "usage",
					inputTokens: chunk.data.usage.promptTokens || 0,
					outputTokens: chunk.data.usage.completionTokens || 0,
				}
			}
		}
	}

	getModel(): { id: MistralModelId; info: ModelInfo } {
		const modelId = this.modelId
		if (modelId && modelId in mistralModels) {
			const id = modelId as MistralModelId
			return { id, info: mistralModels[id] }
		}
		return {
			id: mistralDefaultModelId,
			info: mistralModels[mistralDefaultModelId],
		}
	}
}
