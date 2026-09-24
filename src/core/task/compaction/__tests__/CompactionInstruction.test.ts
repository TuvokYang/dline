import { summarizeTask } from "@core/prompts/contextManagement"
import { PromptProfile } from "@core/prompts/profiles/types"
import { describe, expect, it } from "vitest"
import { renderCompactionInstruction } from "../CompactionInstruction"

const CWD = "/workspace/project"

describe("renderCompactionInstruction", () => {
	it("carries focus-chain guidance for a Standard request with focus tracking enabled", () => {
		const rendered = renderCompactionInstruction({
			cwd: CWD,
			profile: PromptProfile.Standard,
			focusChain: { enabled: true },
			multiRoot: false,
		})

		expect(rendered).toBe(summarizeTask({ enabled: true }, CWD, false))
		expect(rendered).not.toBe(summarizeTask(undefined, CWD, false))
	})

	it("omits focus-chain guidance for a Lite request even when focus tracking is enabled", () => {
		const rendered = renderCompactionInstruction({
			cwd: CWD,
			profile: PromptProfile.Lite,
			focusChain: { enabled: true },
			multiRoot: false,
		})

		expect(rendered).toBe(summarizeTask(undefined, CWD, false))
	})

	it("adds the workspace reference hint only in a multi-root workspace", () => {
		const single = renderCompactionInstruction({ cwd: CWD, profile: PromptProfile.Standard, multiRoot: false })
		const multi = renderCompactionInstruction({ cwd: CWD, profile: PromptProfile.Standard, multiRoot: true })

		expect(multi).toBe(summarizeTask(undefined, CWD, true))
		expect(multi).not.toBe(single)
	})
})
