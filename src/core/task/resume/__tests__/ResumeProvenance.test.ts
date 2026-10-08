import { describe, expect, it } from "vitest"
import {
	createMissingToolResultMessage,
	createResumeInteractionPresentation,
	createResumeSubmissionContext,
} from "../ResumeProvenance"

describe("ResumeProvenance", () => {
	it("presents session restoration without inventing a missing prior tool result", () => {
		const presentation = createResumeInteractionPresentation()

		expect(presentation).toContain("session was closed")
		expect(presentation).toContain("has now been restored")
		expect(presentation).not.toContain("tool call result is missing")
		expect(presentation).not.toContain("outcome is unknown")
		expect(presentation).not.toContain("abnormal")
		expect(presentation).not.toContain("assume the tool use was not successful")
	})

	it("projects missing tool results as unknown and requires observable verification before retry", () => {
		const message = createMissingToolResultMessage("replace_in_file")

		expect(message).toContain("replace_in_file")
		expect(message).toContain("result is missing")
		expect(message).toContain("outcome is unknown")
		expect(message).toContain("inspect its observable state")
		expect(message).toContain("before retrying")
		expect(message).not.toContain("may have been abnormal")
	})

	// Replaces the former `createResumeContinuationText` case. That helper merged
	// provenance into the user's text, but it had no production caller, so no
	// request ever carried the restoration fact. Provenance is now submission
	// context the materializer appends, which keeps the chat row the user's own
	// words, so the contract under test is which dialog kinds have provenance.
	it("states restoration only for a resumed session", () => {
		const resumed = createResumeSubmissionContext("resume")

		expect(resumed).toContain("session was closed")
		expect(resumed).not.toContain("tool call result is missing")
		expect(resumed).not.toContain("outcome is unknown")
	})

	it("claims nothing when a retry happens inside the live session", () => {
		expect(createResumeSubmissionContext("error_retry")).toBeUndefined()
		expect(createResumeSubmissionContext("background_wakeup")).toBeUndefined()
	})
})
