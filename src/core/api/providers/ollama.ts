import { type ModelInfo } from "@shared/api"
import { observeProviderStream } from "@shared/provider-attempt-observer"
import { resolveRuntimeModel } from "@shared/providers/profile-model-info"
import { type Config, type Message, Ollama } from "ollama"
import type { ChatCompletionTool } from "openai/resources/chat/completions"
import { buildExternalBasicHeaders } from "@/services/EnvUtils"
import { ClineStorageMessage } from "@/shared/messages/content"
import { fetch } from "@/shared/net"
import { Logger } from "@/shared/services/Logger"
import type { ApiHandler, ApiHandlerContext } from "../"
import { withRetry } from "../retry"
import { convertToOllamaMessages } from "../transform/ollama-format"
import type { ApiStream } from "../transform/stream"
import { ToolCallProcessor } from "../transform/tool-call-processor"

const DEFAULT_CONTEXT_WINDOW = 32768

export class OllamaHandler implements ApiHandler {
	private client: Ollama | undefined

	constructor(private ctx: ApiHandlerContext) {}

	private get config() {
		return this.ctx.profile.ollama
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
	private get ollamaApiOptionsCtxNum() {
		return (this.config?.ollamaApiOptionsCtxNum ?? DEFAULT_CONTEXT_WINDOW).toString()
	}

	private ensureClient(): Ollama {
		if (!this.client) {
			try {
				const externalHeaders = buildExternalBasicHeaders()
				const clientOptions: Partial<Config> = {
					host: this.baseUrl,
					fetch,
					headers: externalHeaders,
				}

				// Add API key if provided (for Ollama cloud or authenticated instances)
				if (this.apiKey) {
					clientOptions.headers = {
						...clientOptions.headers,
						Authorization: `Bearer ${this.apiKey}`,
					}
				}

				this.client = new Ollama(clientOptions)
			} catch (error) {
				throw new Error(`Error creating Ollama client: ${error.message}`)
			}
		}
		return this.client
	}

	@withRetry({ retryAllErrors: true })
	async *createMessage(systemPrompt: string, messages: ClineStorageMessage[], tools?: ChatCompletionTool[]): ApiStream {
		const client = this.ensureClient()
		const ollamaMessages: Message[] = [{ role: "system", content: systemPrompt }, ...convertToOllamaMessages(messages)]

		try {
			const timeoutMs = this.ctx.requestTimeoutMs || 30000
			const timeoutError = new Error(`Ollama request timed out after ${timeoutMs / 1000} seconds`)
			let timedOut = false

			const apiPromise = observeProviderStream(
				() =>
					client.chat({
						model: this.getModel().id,
						messages: ollamaMessages,
						stream: true,
						options: {
							num_ctx: Number(this.ollamaApiOptionsCtxNum),
						},
						tools: tools as any,
					}),
				{ classifyError: () => (timedOut ? "failed" : undefined) },
			)
			void apiPromise
				.then(async (lateStream) => {
					if (!timedOut) return
					try {
						await lateStream[Symbol.asyncIterator]().throw?.(timeoutError)
					} catch {}
				})
				.catch(() => undefined)

			let timeoutHandle: ReturnType<typeof setTimeout> | undefined
			const timeoutPromise = new Promise<never>((_, reject) => {
				timeoutHandle = setTimeout(() => {
					timedOut = true
					reject(timeoutError)
					try {
						client.abort()
					} catch (abortError) {
						Logger.error("Failed to abort timed-out Ollama request:", abortError)
					}
				}, timeoutMs)
			})

			const toolCallProcessor = new ToolCallProcessor()

			// Race the API request against the timeout
			let stream: Awaited<typeof apiPromise>
			try {
				stream = (await Promise.race([apiPromise, timeoutPromise])) as Awaited<typeof apiPromise>
			} finally {
				if (timeoutHandle) clearTimeout(timeoutHandle)
			}

			try {
				for await (const chunk of stream) {
					Logger.debug(`[OllamaHandler] Message Chunk${JSON.stringify(chunk)}`)

					const delta = chunk.message

					if (delta?.tool_calls) {
						Logger.debug(`[OllamaHandler] Tool Calls Detected: ${JSON.stringify(delta.tool_calls)}`)
						yield* toolCallProcessor.processToolCallDeltas(
							delta.tool_calls?.map((tc, inx) => ({
								index: inx,
								id: `ollama-tool-${inx}`,
								function: {
									name: tc.function.name,
									arguments:
										typeof tc.function.arguments === "string"
											? tc.function.arguments
											: JSON.stringify(tc.function.arguments),
								},
								type: "function",
							})),
						)
					}

					if (typeof delta.content === "string") {
						yield {
							type: "text",
							text: delta.content,
						}
					}
					// Handle token usage if available
					if (chunk.eval_count !== undefined || chunk.prompt_eval_count !== undefined) {
						yield {
							type: "usage",
							inputTokens: chunk.prompt_eval_count || 0,
							outputTokens: chunk.eval_count || 0,
						}
					}
				}
			} catch (streamError: any) {
				Logger.error("Error processing Ollama stream:", streamError)
				throw new Error(`Ollama stream processing error: ${streamError.message || "Unknown error"}`)
			}
		} catch (error) {
			// Check if it's a timeout error
			if (error?.message?.includes("timed out")) {
				const timeoutMs = this.ctx.requestTimeoutMs || 30000
				throw new Error(`Ollama request timed out after ${timeoutMs / 1000} seconds`)
			}

			// Enhance error reporting
			const statusCode = error.status || error.statusCode
			const errorMessage = error.message || "Unknown error"

			Logger.error(`Ollama API error (${statusCode || "unknown"}): ${errorMessage}`)
			throw error
		}
	}

	getModel(): { id: string; info: ModelInfo } {
		const model = resolveRuntimeModel(this.ctx.profile)
		return {
			...model,
			info: {
				...model.info,
				capabilities: { ...model.info.capabilities, contextWindow: Number(this.ollamaApiOptionsCtxNum) },
			},
		}
	}

	abort(): void {
		this.client?.abort()
	}
}
