import { describe, expect, it } from "vitest"
import {
	compactionSummaryMessage,
	formatPreviousCompactionSummary,
	PREVIOUS_COMPACTION_SUMMARY_TAG,
} from "../compaction-summary-message"

const SUMMARY = "1. Previous Conversation:\n   The user asked for a fix."

describe("compaction summary message", () => {
	it("delimits the summary and labels it as written by the previous compaction", () => {
		const text = formatPreviousCompactionSummary(SUMMARY)

		expect(text.startsWith(`<${PREVIOUS_COMPACTION_SUMMARY_TAG}>\n`)).toBe(true)
		expect(text.endsWith(`\n\n${SUMMARY}\n</${PREVIOUS_COMPACTION_SUMMARY_TAG}>`)).toBe(true)
		expect(text).toContain("written by the previous compaction")
		expect(text).toContain("not a user message")
	})

	it("projects the delimited summary as a single user-role text block", () => {
		expect(compactionSummaryMessage(SUMMARY)).toEqual({
			role: "user",
			content: [{ type: "text", text: formatPreviousCompactionSummary(SUMMARY) }],
		})
	})
})
