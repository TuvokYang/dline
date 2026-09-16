import http from "node:http"
import type { AddressInfo } from "node:net"
import type { ApiProfile } from "@shared/proto/dline/profile"
import { afterEach, describe, expect, it } from "vitest"
import type { ImageGenerationEvent, ImageGenerationRequest } from "../../contracts"
import { GeminiImageGenerationAdapter } from "../GeminiImageGenerationAdapter"
import { OpenAIImageGenerationAdapter } from "../OpenAIImageGenerationAdapter"

const servers: http.Server[] = []

async function startServer(responseBody: unknown): Promise<{ baseUrl: string; requests: string[] }> {
	const requests: string[] = []
	const server = http.createServer((request, response) => {
		requests.push(`http://${request.headers.host}${request.url}`)
		request.resume()
		response.writeHead(200, { "content-type": "application/json" })
		response.end(JSON.stringify(responseBody))
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	servers.push(server)
	const address = server.address() as AddressInfo
	return { baseUrl: `http://127.0.0.1:${address.port}`, requests }
}

async function collect(events: AsyncIterable<ImageGenerationEvent>): Promise<ImageGenerationEvent[]> {
	const values: ImageGenerationEvent[] = []
	for await (const event of events) values.push(event)
	return values
}

function request(providerId: string, modelId: string): ImageGenerationRequest {
	return {
		requestId: `request-${providerId}`,
		profileId: `profile-${providerId}`,
		providerId,
		modelId,
		operation: "generate",
		prompt: "A blue owl",
		count: 1,
		outputFormat: "png",
		references: [],
	}
}

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

describe("image adapter custom URL transport", () => {
	it("sends OpenAI image generation only to the configured custom URL", async () => {
		const transport = await startServer({ data: [{ b64_json: "iVBORw0KGgo=" }] })
		const profile = {
			id: "profile-openai",
			name: "OpenAI custom",
			provider: "openai",
			apiKey: "test-openai-key",
			baseUrl: `${transport.baseUrl}/v1`,
			imageModelId: "gpt-image-2",
			enabled: true,
			usedFor: ["image"],
		} as ApiProfile
		const events = await collect(
			new OpenAIImageGenerationAdapter({ profile, modelId: profile.imageModelId ?? "" }).generate(
				request("openai", "gpt-image-2"),
				{ signal: new AbortController().signal },
			),
		)
		expect(events.at(-1)?.type).toBe("completed")
		expect(transport.requests).toHaveLength(1)
		expect(transport.requests[0]).toMatch(
			new RegExp(`^${transport.baseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/v1/images/generations`),
		)
		expect(transport.requests.join(" ")).not.toContain("api.openai.com")
	})

	it("sends Gemini image generation only to the configured custom URL", async () => {
		const transport = await startServer({
			candidates: [{ content: { parts: [{ inlineData: { data: "iVBORw0KGgo=", mimeType: "image/png" } }] } }],
		})
		const profile = {
			id: "profile-gemini",
			name: "Gemini custom",
			provider: "gemini",
			apiKey: "test-gemini-key",
			baseUrl: transport.baseUrl,
			imageModelId: "gemini-3.1-flash-image",
			enabled: true,
			usedFor: ["image"],
		} as ApiProfile
		const events = await collect(
			new GeminiImageGenerationAdapter({ profile, modelId: profile.imageModelId ?? "" }).generate(
				request("gemini", "gemini-3.1-flash-image"),
				{ signal: new AbortController().signal },
			),
		)
		expect(events.at(-1)?.type).toBe("completed")
		expect(transport.requests).toHaveLength(1)
		expect(transport.requests[0]).toContain(transport.baseUrl)
		expect(transport.requests.join(" ")).not.toContain("generativelanguage.googleapis.com")
	})
})
