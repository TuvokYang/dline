import type { Mode } from "@shared/storage/types"
import { describe, expect, it } from "vitest"
import type { StartSuccessorTaskPostCommitDirective } from "../../tools/ToolExecutionResult"
import { createNewTaskHandoff, type NewTaskSettingsSource, successorSubmission } from "../new-task-handoff"

interface StableProfileSettingsSource extends NewTaskSettingsSource {
	readonly planModeProfileId: string
	readonly actModeProfileId: string
}

describe("createNewTaskHandoff Profile identity", () => {
	it("inherits stable Profile IDs together with the display names", () => {
		const directive: StartSuccessorTaskPostCommitDirective = {
			type: "start_successor_task",
			context: "Continue the isolated task",
			functionId: "function-new-task",
			dlineTid: "tid-new-task",
		}
		const source: StableProfileSettingsSource = {
			mode: "act" as Mode,
			planModeProfileId: "plan-profile-id",
			planModeProfile: "plan-profile",
			actModeProfileId: "act-profile-id",
			actModeProfile: "act-profile",
		}

		const handoff = createNewTaskHandoff(directive, source, [])

		expect(handoff.taskSettings).toMatchObject({
			mode: "act",
			planModeProfileId: "plan-profile-id",
			planModeProfile: "plan-profile",
			actModeProfileId: "act-profile-id",
			actModeProfile: "act-profile",
		})
	})
})

describe("successorSubmission", () => {
	it("carries feedback text as submission context and images as data URLs", () => {
		const submission = successorSubmission([
			{ type: "text", text: "<feedback>\nNarrow the scope\n</feedback>" },
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
			{ type: "text", text: "<file_content>notes</file_content>" },
		])

		expect(submission).toEqual({
			context: ["<feedback>\nNarrow the scope\n</feedback>", "<file_content>notes</file_content>"],
			images: ["data:image/png;base64,iVBORw0KGgo="],
		})
	})

	it("submits nothing extra when the user gave no feedback", () => {
		expect(successorSubmission([])).toEqual({ context: [], images: [] })
	})
})
