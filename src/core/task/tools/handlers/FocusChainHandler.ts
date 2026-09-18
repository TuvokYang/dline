import type { ToolUse } from "@core/assistant-message"
import { getPrompt } from "@core/prompts/i18n"
import { ClineDefaultTool } from "@/shared/tools"
import { hasChecklistTitle, hasValidTodoItem } from "../../focus-chain/file-utils"
import type { ToolResponse } from "../../index"
import type { IToolHandler } from "../ToolExecutorCoordinator"
import type { TaskConfig } from "../types/TaskConfig"

/**
 * Handles focus chain change tool.
 * Allows AI to request plan changes with user approval.
 */
export class FocusChainHandler implements IToolHandler {
	readonly name = ClineDefaultTool.CHANGE_TODO_LIST

	getDescription(block: ToolUse): string {
		return `[${block.name}] Request TODO list change`
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		const newPlan = (block.params as Record<string, string>).new_plan?.trim()
		const reason = (block.params as Record<string, string>).reason || ""

		if (!newPlan || !hasChecklistTitle(newPlan) || !hasValidTodoItem(newPlan)) {
			return getPrompt("focusChain", "focusChainChangeMissing")
		}

		const outcome = block.dline_tid ? config.admissionOutcomes?.get(block.dline_tid) : undefined
		const approvedPlan = outcome ? this.selectPlan(newPlan, outcome.selection?.values ?? []) : newPlan

		// Clean approvedPlan for focus chain file:
		// - Remove "[-] - " lines (rejected items)
		// - Convert "[+] - " prefix to "- " (approved items)
		// - Remove empty section headings
		// - Keep "- [x]" lines as-is (already completed)
		const focusChainPlan = this.cleanForFocusChain(approvedPlan).trim()
		if (!hasChecklistTitle(focusChainPlan) || !hasValidTodoItem(focusChainPlan)) {
			return getPrompt("focusChain", "focusChainChangeNoItemsApproved")
		}
		await config.callbacks.focusChainForceUpdate(focusChainPlan)
		await config.callbacks.say(
			"tool",
			JSON.stringify({ tool: "focusChainChanged", path: focusChainPlan, content: reason }),
			undefined,
			undefined,
			false,
			block.ts,
		)
		return getPrompt("focusChain", "focusChainChangeApproved")
	}

	/** Build the approved plan from stable pending-item indices. */
	private selectPlan(plan: string, selection: string[]): string {
		const selected = new Set(selection)
		let pendingIndex = 0
		return plan
			.split("\n")
			.filter((line) => {
				if (!line.trim().startsWith("- [ ]")) {
					return true
				}
				const keep = selected.has(String(pendingIndex))
				pendingIndex += 1
				return keep
			})
			.join("\n")
	}

	/**
	 * Clean a marked plan for focus chain file output.
	 */
	private cleanForFocusChain(markedPlan: string): string {
		const lines = markedPlan.split("\n")
		const result: string[] = []
		let pendingHeading: string | null = null

		for (const line of lines) {
			const trimmed = line.trim()
			if (trimmed.startsWith("## ")) {
				pendingHeading = trimmed
			} else if (trimmed.startsWith("[-] - ")) {
				// Rejected item — skip
			} else if (trimmed.startsWith("[+] - ")) {
				if (pendingHeading) {
					result.push(pendingHeading)
					pendingHeading = null
				}
				result.push(trimmed.replace(/^\[\+\]\s*-\s*\[\s*\]\s*/, "- [ ] "))
			} else if (trimmed.startsWith("- [")) {
				if (pendingHeading) {
					result.push(pendingHeading)
					pendingHeading = null
				}
				result.push(trimmed)
			} else if (trimmed.startsWith("# ") || trimmed === "") {
				if (pendingHeading) {
					result.push(pendingHeading)
					pendingHeading = null
				}
				result.push(trimmed)
			}
		}
		return result.join("\n")
	}
}
