import { ClineDefaultTool } from "@shared/tools"
import { describe, expect, it } from "vitest"
import type { ParseTsRegistry } from "./parse-assistant-message"
import { parseAssistantMessage } from "./parse-assistant-message"

function createRegistry(): ParseTsRegistry {
	let nextTs = 1
	const blockTs = new Map<string, number>()
	const toolIdentities = new Map<string, { function_id: string; dline_tid: string }>()

	return {
		getOrCreateTsForBlock: (key) => {
			const existing = blockTs.get(key)
			if (existing !== undefined) return existing
			const ts = nextTs++
			blockTs.set(key, ts)
			return ts
		},
		getOrCreateToolIdentityForBlock: (key) => {
			const existing = toolIdentities.get(key)
			if (existing) return existing
			const identity = { function_id: `function-${key}`, dline_tid: `trace-${key}` }
			toolIdentities.set(key, identity)
			return identity
		},
	}
}

describe("parseAssistantMessage summarize_task context", () => {
	it("keeps a literal closing payload and all following summary text inside the completed tool context", () => {
		const summary = [
			"Preserve the prompt requirement to close with `</context></summarize_task>` before the hard limit.",
			"This sentence must remain in the same rendered summary after that literal payload.",
		].join("\n")
		const blocks = parseAssistantMessage(`<summarize_task><context>${summary}</context></summarize_task>`, createRegistry())

		expect(blocks).toHaveLength(1)
		expect(blocks[0]).toMatchObject({
			type: "tool_use",
			name: ClineDefaultTool.SUMMARIZE_TASK,
			partial: false,
			params: { context: summary },
		})
	})

	it("keeps text after a literal closing payload in the partial tool context while streaming", () => {
		const partialSummary =
			"Remember `</context></summarize_task>` as literal guidance, then keep streaming the rest of this summary."
		const blocks = parseAssistantMessage(`<summarize_task><context>${partialSummary}`, createRegistry())

		expect(blocks).toHaveLength(1)
		expect(blocks[0]).toMatchObject({
			type: "tool_use",
			name: ClineDefaultTool.SUMMARIZE_TASK,
			partial: true,
			params: { context: partialSummary },
		})
	})

	it("parses task progress after the terminal summary context", () => {
		const summary = "Complete summary"
		const taskProgress = "- [x] Preserve the parser contract\n- [ ] Continue verification"
		const blocks = parseAssistantMessage(
			`<summarize_task><context>${summary}</context><task_progress>${taskProgress}</task_progress></summarize_task>`,
			createRegistry(),
		)

		expect(blocks).toHaveLength(1)
		expect(blocks[0]).toMatchObject({
			type: "tool_use",
			name: ClineDefaultTool.SUMMARIZE_TASK,
			partial: false,
			params: { context: summary, task_progress: taskProgress },
		})
	})

	it("keeps a quoted full tool tail inside the summary when more summary text follows", () => {
		const quotedTail = "</context><task_progress>- [x] Example</task_progress></summarize_task>"
		const summary = `Quote ${quotedTail} literally, then preserve this final sentence.`
		const blocks = parseAssistantMessage(`<summarize_task><context>${summary}</context></summarize_task>`, createRegistry())

		expect(blocks).toHaveLength(1)
		expect(blocks[0]).toMatchObject({
			type: "tool_use",
			name: ClineDefaultTool.SUMMARIZE_TASK,
			partial: false,
			params: { context: summary },
		})
	})

	it("uses the actual terminal task progress instead of a quoted task progress tail", () => {
		const quotedTail = "</context><task_progress>- [x] Quoted example</task_progress></summarize_task>"
		const summary = `Quote ${quotedTail} literally, then preserve this final sentence.`
		const taskProgress = "- [x] Actual completed item\n- [ ] Actual current item"
		const blocks = parseAssistantMessage(
			`<summarize_task><context>${summary}</context><task_progress>${taskProgress}</task_progress></summarize_task>`,
			createRegistry(),
		)

		expect(blocks).toHaveLength(1)
		expect(blocks[0]).toMatchObject({
			type: "tool_use",
			name: ClineDefaultTool.SUMMARIZE_TASK,
			partial: false,
			params: { context: summary, task_progress: taskProgress },
		})
	})
})
