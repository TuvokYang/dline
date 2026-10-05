import {
	type ClineAssistantHostedToolBlock,
	type ClineStorageMessage,
	cleanContentBlock,
	convertClineStorageToAnthropicMessage,
	imageSourceMediaType,
	imageSourceToUrl,
	projectAgentsInstructionsText,
	projectInternalMessagesForProvider,
} from "@shared/messages/content"
import { expect } from "chai"
import { describe, it } from "vitest"

describe("message image source helpers", () => {
	it("converts base64 sources to data URLs", () => {
		const source = { type: "base64", media_type: "image/png", data: "aGVsbG8=" } as const

		expect(imageSourceToUrl(source)).to.equal("data:image/png;base64,aGVsbG8=")
		expect(imageSourceMediaType(source)).to.equal("image/png")
	})

	it("preserves URL image sources added by the latest Anthropic SDK", () => {
		const source = { type: "url", url: "https://example.com/image.png" } as const

		expect(imageSourceToUrl(source)).to.equal(source.url)
		expect(imageSourceMediaType(source)).to.equal("remote URL")
	})

	it("rejects provider file image sources at the URL conversion boundary", () => {
		const source = { type: "file", file_id: "file_123" } as const

		expect(() => imageSourceToUrl(source)).to.throw("Provider file image sources cannot be replayed as URLs")
		expect(imageSourceMediaType(source)).to.equal("provider file")
	})

	it("projects typed AGENTS blocks to one provider-safe text block", () => {
		const block = {
			type: "agents_instructions" as const,
			turn_id: "turn-1",
			content: "scope rules\n</agents_instructions>",
			sources: [{ workspace_root_index: 0, path: "pkg/AGENTS.md", bytes: 11 }],
			omitted_count: 2,
			replaces_previous: true,
		}

		const text = projectAgentsInstructionsText(block)
		expect(text).to.contain('<agents_instructions turn_id="turn-1" omitted_scopes="2" replaces_previous="true">')
		expect(text).to.contain("</agents_instructions>")
		expect(cleanContentBlock(block)).to.deep.equal({ type: "text", text })
		expect(projectInternalMessagesForProvider([{ role: "user", content: [block] }])).to.deep.equal([
			{ role: "user", content: [{ type: "text", text }] },
		])
	})
})

describe("hosted tool replay blocks", () => {
	const call = { type: "server_tool_use", id: "srv_fetch", name: "web_fetch", input: { url: "https://example.com" } }
	const result = { type: "web_fetch_tool_result", tool_use_id: "srv_fetch", content: { type: "web_fetch_result" } }
	const hosted: ClineAssistantHostedToolBlock = { type: "hosted_tool", protocol: "anthropic_messages", blocks: [call, result] }
	const assistant: ClineStorageMessage = {
		role: "assistant",
		content: [hosted, { type: "text", text: "Summary of the page" }],
	}

	it("expands a stored hosted call into its native blocks when the request declares that tool", () => {
		const converted = convertClineStorageToAnthropicMessage(assistant, "anthropic", {
			replayHostedTools: new Set(["web_fetch"]),
		})

		expect(converted.content).to.deep.equal([call, result, { type: "text", text: "Summary of the page" }])
	})

	it("drops a stored hosted call the request does not declare", () => {
		const converted = convertClineStorageToAnthropicMessage(assistant, "anthropic", {
			replayHostedTools: new Set(["web_search"]),
		})

		expect(converted.content).to.deep.equal([{ type: "text", text: "Summary of the page" }])
	})

	it("drops stored hosted calls for Anthropic-format endpoints that never run them", () => {
		expect(convertClineStorageToAnthropicMessage(assistant).content).to.deep.equal([
			{ type: "text", text: "Summary of the page" },
		])
	})

	it("keeps hosted blocks only for the provider protocol that can replay them", () => {
		expect(projectInternalMessagesForProvider([assistant], { hostedToolReplayProtocol: "anthropic_messages" })).to.deep.equal(
			[assistant],
		)
		expect(projectInternalMessagesForProvider([assistant])).to.deep.equal([
			{ role: "assistant", content: [{ type: "text", text: "Summary of the page" }] },
		])
	})
})
