import { readFile } from "node:fs/promises"
import path from "node:path"
import { describe, expect, it } from "vitest"

const taskSourcePath = path.resolve("src/core/task/index.ts")

function extractRequestMethod(source: string): string {
	const start = source.indexOf("async recursivelyMakeClineRequests(")
	const end = source.indexOf("\n\tasync loadContext(", start)
	if (start < 0 || end < 0) {
		throw new Error("Unable to locate the Task request boundary")
	}
	return source.slice(start, end)
}

function extractServerToolCase(method: string): string {
	const start = method.indexOf('case "server_tool": {')
	const end = method.indexOf("break", start)
	if (start < 0 || end < 0) {
		throw new Error("Unable to locate the Task server_tool stream case")
	}
	return method.slice(start, end)
}

/**
 * The Task stream loop owns the stored assistant turn. These checks keep the provider-hosted replay
 * wiring intact: without it, hosted web results are shown in the UI but never reach a later request.
 */
describe("Task provider-hosted tool replay", () => {
	it("collects the replay carried by a terminal server_tool chunk", async () => {
		const serverToolCase = extractServerToolCase(extractRequestMethod(await readFile(taskSourcePath, "utf8")))

		expect(serverToolCase).toContain("if (chunk.replay) hostedToolBlocks.push(chunk.replay)")
		expect(serverToolCase.indexOf("hostedToolBlocks.push(chunk.replay)")).toBeLessThan(
			serverToolCase.indexOf("consumeServerToolChunk(chunk)"),
		)
	})

	it("stores hosted blocks after reasoning and before the visible answer", async () => {
		const method = extractRequestMethod(await readFile(taskSourcePath, "utf8"))
		const thinking = method.indexOf("assistantContent.push({ ...thinkingBlock })")
		expect(method).toContain("assistantContent.unshift(...hostedTurn.resumed)")
		const hosted = method.indexOf("assistantContent.push(...hostedTurn.others)")
		const text = method.indexOf("const hasAssistantText = assistantTextOnly.trim().length > 0")

		expect(thinking).toBeGreaterThanOrEqual(0)
		expect(hosted).toBeGreaterThan(thinking)
		expect(text).toBeGreaterThan(hosted)
	})

	it("projects history with the replay protocol of the handler that serves the request", async () => {
		const source = await readFile(taskSourcePath, "utf8")
		const projection = source.indexOf("projectInternalMessagesForProvider(")

		expect(projection).toBeGreaterThanOrEqual(0)
		expect(source.slice(projection, projection + 300)).toContain(
			"hostedToolReplayProtocol: requestScope.api.getHostedToolReplayProtocol?.()",
		)
	})
})
