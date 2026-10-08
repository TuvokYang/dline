import { isCompletedFocusChainItem, isFocusChainItem, parseFocusChainItem } from "@shared/focus-chain-utils"
import * as fs from "fs/promises"
import * as path from "path"
import { ensureTaskDirectoryExists } from "../../storage/disk"

/**
 * Generate the standard file path for a task's focusChain markdown file
 */
export function getFocusChainFilePath(taskDir: string, taskId: string): string {
	return path.join(taskDir, `focus_chain_taskid_${taskId}.md`)
}

/**
 * Generate the file path for a task's focusChain history file
 */
export function getFocusChainHistoryFilePath(taskDir: string, taskId: string): string {
	return path.join(taskDir, `focus_chain_taskid_${taskId}_history.md`)
}

/**
 * Create the standard markdown content structure for a focusChain file
 */
export function createFocusChainMarkdownContent(taskId: string, focusChainList: string): string {
	return `# Focus Chain List for Task ${taskId}

<!-- Edit this markdown file to update your focus chain list -->
<!-- Use the format: ## Section Title for grouping, - [ ] for incomplete items and - [x] for completed items -->

${focusChainList}

<!-- Save this file and the focus chain list will be updated in the task -->`
}

/**
 * Create the initial content for a focusChain history file
 */
export function createFocusChainHistoryHeader(taskId: string): string {
	return `# Focus Chain History for Task ${taskId}

<!-- Completed task items are automatically archived here -->
<!-- Each entry includes a timestamp and the completed items at that point -->

`
}

/**
 * Format a completed focus chain into a history entry with timestamp.
 * Preserves # Title and ## Section headings from the original content.
 * @param focusChainText - The complete focus chain text with headings and items
 * @param timestamp - ISO timestamp string
 * @returns Formatted history entry string
 */
export function formatHistoryEntry(focusChainText: string, timestamp: string): string {
	if (!focusChainText.trim()) {
		return ""
	}
	// Use local time with dynamic timezone offset
	const now = new Date(timestamp)
	const tzOffset = -now.getTimezoneOffset()
	const tzHours = Math.floor(Math.abs(tzOffset) / 60)
	const tzSign = tzOffset >= 0 ? "+" : "-"
	const pad = (n: number) => String(n).padStart(2, "0")
	const dateStr =
		`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
		`${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())} ` +
		`UTC${tzSign}${tzHours}`
	let entry = `\n## Completed — ${dateStr}\n`

	// Preserve the full structure including # Title and ## Section headings
	const lines = focusChainText.split("\n")
	for (const line of lines) {
		const trimmed = line.trim()
		if (!trimmed) {
			continue
		}
		// Keep headings and checklist items
		if (trimmed.startsWith("# ") || trimmed.startsWith("## ") || isFocusChainItem(trimmed)) {
			entry += `${trimmed}\n`
		}
	}
	return entry
}

/**
 * Append completed focus chain to the history file, creating it with a header if needed.
 * Preserves the full structure including # Title and ## Section headings.
 * @param taskDir - The task directory path
 * @param taskId - The task ID
 * @param focusChainText - The complete focus chain text to archive
 */
export async function appendToFocusChainHistory(taskDir: string, taskId: string, focusChainText: string): Promise<void> {
	if (!focusChainText.trim()) {
		return
	}

	const historyPath = getFocusChainHistoryFilePath(taskDir, taskId)

	// Check if history file exists, create with header if not
	let fileExists = false
	try {
		await fs.access(historyPath)
		fileExists = true
	} catch {
		// File doesn't exist, create with header
	}

	if (!fileExists) {
		const header = createFocusChainHistoryHeader(taskId)
		await fs.writeFile(historyPath, header, "utf8")
	}

	// Append the new entry
	const entry = formatHistoryEntry(focusChainText, new Date().toISOString())
	await fs.appendFile(historyPath, entry, "utf8")
}

/**
 * Extract focusChain items from text content (markdown or message text)
 * Returns array of lines that match focusChain item format
 */
export function extractFocusChainItemsFromText(text: string): string[] {
	const lines = text.split("\n")
	return lines.filter((line) => {
		const trimmed = line.trim()
		return isFocusChainItem(trimmed)
	})
}

/** Return the exact unchecked item at a checklist item index, or null when the index is stale. */
export function getUncheckedFocusChainItemAtIndex(checklist: string, itemIndex: number | null): string | null {
	if (itemIndex === null || itemIndex < 0) {
		return null
	}

	const item = extractFocusChainItemsFromText(checklist)[itemIndex]?.trim()
	if (!item || isCompletedFocusChainItem(item)) {
		return null
	}
	return item
}

/** Format the environment task_progress section without mutating canonical checklist item text. */
export function formatFocusChainTaskProgressSection(checklist: string, itemIndex: number | null): string {
	const currentItem = getUncheckedFocusChainItemAtIndex(checklist, itemIndex)
	const currentSection = currentItem ? `\n\nCURRENT:\n${currentItem}` : ""
	return `# task_progress\n${checklist}${currentSection}`
}

/** Return whether text contains at least one standard TODO item with non-empty item text. */
export function hasValidTodoItem(text: string): boolean {
	return text.split("\n").some((line) => parseFocusChainItem(line.trim()) !== null)
}

/**
 * Extract focusChain content preserving headings and items.
 * Returns the complete focus chain text including #/## headings and - [ ] items.
 */
export function extractFocusChainListFromText(text: string): string | null {
	const lines = text.split("\n")
	const resultLines: string[] = []

	for (const line of lines) {
		const trimmed = line.trim()
		if (!trimmed) {
			continue
		}
		// Skip the template header line to prevent nesting
		if (trimmed.startsWith("# Focus Chain List for Task")) {
			continue
		}
		// Preserve headings and checklist items, skip other lines
		if (trimmed.startsWith("# ") || trimmed.startsWith("## ") || isFocusChainItem(trimmed)) {
			resultLines.push(trimmed)
		}
	}

	return resultLines.length > 0 ? resultLines.join("\n") : null
}

/**
 * Whether two checklist texts describe the same checklist once reduced to their persisted form.
 * Blank lines, indentation and non-checklist prose are formatting, not checklist content.
 */
export function isEquivalentFocusChainList(left: string, right: string): boolean {
	return extractFocusChainListFromText(left) === extractFocusChainListFromText(right)
}

/**
 * Check if all items in the old list are completed.
 * Used to trigger archiving when a task group is fully done.
 * @param text - The focus chain content to check
 * @returns true if all items are [x]
 */
export function isAllItemsCompleted(text: string): boolean {
	const items = extractFocusChainItemsFromText(text)
	if (items.length === 0) {
		return false
	}
	return items.every((item) => isCompletedFocusChainItem(item))
}

/**
 * Detect if AI has tampered with the checklist: removed or rewrote items
 * that were still marked [ ] (incomplete), instead of just marking them [x].
 * @param oldText - The previous focus chain content
 * @param newText - The new focus chain content
 * @returns Array of tampered item texts, or empty if clean
 */
export function detectTampering(oldText: string, newText: string): string[] {
	const oldItems = extractFocusChainItemsFromText(oldText)
	const newItems = extractFocusChainItemsFromText(newText)

	const normalizeItem = (item: string): string => {
		return item.replace(/^-\s*\[[ xX]\]\s*/, "").trim()
	}

	const newNormalized = new Set(newItems.map(normalizeItem))

	// Find old items that were [ ] (incomplete) but are now gone from the new list
	return oldItems
		.filter((item) => {
			if (isCompletedFocusChainItem(item)) {
				return false // [x] items can be removed (archived)
			}
			return !newNormalized.has(normalizeItem(item))
		})
		.map(normalizeItem)
}

/**
 * Find all completed items in the old list.
 * Used when all items are done to archive the entire list.
 * @param text - The focus chain content
 * @returns Array of completed item lines
 */
export function findAllCompletedItems(text: string): string[] {
	return extractFocusChainItemsFromText(text).filter((item) => isCompletedFocusChainItem(item))
}

/**
 * Ensure a focusChain file exists, creating it with provided content if it doesn't exist
 * Returns the file path
 */
/**
 * Check if the text contains a new checklist header (# Title or ## Section)
 * Used to detect when AI is creating a new checklist vs. reporting completed items.
 * @param text - The task_progress text from the AI
 * @returns true if the text contains # or ## header lines
 */
export function hasNewChecklistHeader(text: string): boolean {
	const lines = text.split("\n")
	return lines.some((line) => {
		const trimmed = line.trim()
		return trimmed.startsWith("# ") || trimmed.startsWith("## ")
	})
}

/** Return whether text contains the required top-level checklist title. */
export function hasChecklistTitle(text: string): boolean {
	return text.split("\n").some((line) => line.trim().startsWith("# "))
}

/** Return whether text contains at least one non-empty unchecked checklist item. */
export function hasUncheckedFocusChainItem(text: string): boolean {
	return extractFocusChainItemsFromText(text).some((item) => !isCompletedFocusChainItem(item))
}

/**
 * Result of merging completed items into the existing checklist.
 */
export interface MergeResult {
	/** The merged checklist text with completed items marked as - [x] */
	mergedText: string
	/** Items from the report that could not be matched to any checklist item */
	unmatchedItems: string[]
}

/**
 * Merge AI-reported completed items into the existing focus chain checklist.
 * Each reported item must match exactly (after stripping checkbox prefix) to an
 * existing - [ ] item in the checklist. Matched items are marked as - [x].
 *
 * @param existingChecklist - The current focus chain checklist text
 * @param completedItemsText - The task_progress text from AI (only - [x] lines)
 * @returns MergeResult with updated checklist and any unmatched items
 */
export function mergeCompletedItems(existingChecklist: string, completedItemsText: string): MergeResult {
	const lines = existingChecklist.split("\n")
	const reportedLines = completedItemsText
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => isCompletedFocusChainItem(l))

	// Normalize: strip "- [x] " prefix, trim whitespace
	const normalizeItem = (item: string): string => {
		return item.replace(/^-\s*\[[ xX]\]\s*/, "").trim()
	}

	const reportedTexts = reportedLines.map(normalizeItem)
	const unmatchedItems: string[] = []

	// Build a map of normalized text -> whether already matched
	const reportedMatched = new Map<string, boolean>()
	for (const t of reportedTexts) {
		reportedMatched.set(t, false)
	}

	// Process each line of the existing checklist
	const mergedLines = lines.map((line) => {
		const trimmed = line.trim()
		// Only process unchecked items
		if (!isFocusChainItem(trimmed) || isCompletedFocusChainItem(trimmed)) {
			return line
		}

		const normalizedExisting = normalizeItem(trimmed)

		// Check if this item matches any reported completed item
		if (reportedMatched.has(normalizedExisting) && !reportedMatched.get(normalizedExisting)) {
			reportedMatched.set(normalizedExisting, true)
			// Replace the line, preserving original indentation
			return line.replace(trimmed, trimmed.replace(/^-\s*\[ \]/, "- [x]"))
		}

		return line
	})

	// Collect unmatched items, excluding idempotent reports (already [x])
	for (const [text, matched] of reportedMatched) {
		if (!matched) {
			// Idempotent check: item already completed in existing checklist
			const alreadyDone = lines.some((line) => {
				const t = line.trim()
				return isCompletedFocusChainItem(t) && normalizeItem(t) === text
			})
			if (!alreadyDone) {
				unmatchedItems.push(text)
			}
		}
	}

	return {
		mergedText: mergedLines.join("\n"),
		unmatchedItems,
	}
}

/**
 * Result of processing a reported in-progress item (- [ ]).
 */
export interface InProgressResult {
	/** The checklist text with the in-progress item marked, or null if no match */
	updatedText: string | null
	/** The matched item text from the checklist */
	matchedItem: string | null
	/** 0-based index of the matched item among all checklist items (ignoring headings/blank lines) */
	matchedItemIndex: number | null
}

/**
 * Process an AI-reported in-progress item (- [ ]), marking it as the current step.
 * Only the FIRST - [ ] from the report is accepted. Previous markers are cleared.
 *
 * @param existingChecklist - The current focus chain checklist text
 * @param inProgressText - The task_progress text from AI (only - [ ] lines)
 * @returns InProgressResult with updated checklist text and matched item
 */
export function mergeInProgressItem(existingChecklist: string, inProgressText: string): InProgressResult {
	const reportedLines = inProgressText
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => isFocusChainItem(l) && !isCompletedFocusChainItem(l))

	if (reportedLines.length === 0) {
		return { updatedText: null, matchedItem: null, matchedItemIndex: null }
	}

	const inProgressLine = reportedLines[0]
	const normalizeItem = (item: string): string => {
		return item.replace(/^-\s*\[[ xX]\]\s*/, "").trim()
	}
	const normalizedInProgress = normalizeItem(inProgressLine)

	// Compute the index of the matched item among all checklist items
	let itemIdx = 0
	let matchedItemIndex: number | null = null
	let matched = false

	const mergedLines = existingChecklist.split("\n").map((line) => {
		const trimmed = line.trim()
		// Ignore headings and blank lines — they don't count as items
		if (!isFocusChainItem(trimmed)) {
			return line
		}
		// Already completed items — count but skip matching
		if (isCompletedFocusChainItem(trimmed)) {
			itemIdx++
			return line
		}
		// This is an unchecked item — try to match
		const normalizedExisting = normalizeItem(trimmed)
		if (normalizedExisting === normalizedInProgress && !matched) {
			matched = true
			matchedItemIndex = itemIdx
		}
		itemIdx++
		// Return the line as-is (no <- CURRENT marker written into text)
		return line
	})

	if (!matched) {
		return { updatedText: null, matchedItem: null, matchedItemIndex: null }
	}

	return {
		updatedText: mergedLines.join("\n"),
		matchedItem: inProgressLine,
		matchedItemIndex,
	}
}

/**
 * Extract the first few unchecked items from a checklist for use as examples
 * in rejection messages. Helps the AI understand the expected format.
 *
 * @param checklist - The current focus chain checklist text
 * @param count - Maximum number of items to extract (default 3)
 * @returns Array of item texts (with - [ ] prefix)
 */
export function extractExampleItems(checklist: string, count = 3): string[] {
	return checklist
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => isFocusChainItem(l) && !isCompletedFocusChainItem(l))
		.slice(0, count)
}

export async function ensureFocusChainFile(taskId: string, initialFocusChainContent?: string): Promise<string> {
	const taskDir = await ensureTaskDirectoryExists(taskId)
	const focusChainFilePath = getFocusChainFilePath(taskDir, taskId)

	// Check if file exists
	let fileExists = false
	try {
		await fs.access(focusChainFilePath)
		fileExists = true
	} catch {
		// File doesn't exist
	}

	// Create file if it doesn't exist
	if (!fileExists) {
		const focusChainContent = initialFocusChainContent || ""
		const fileContent = createFocusChainMarkdownContent(taskId, focusChainContent)
		await fs.writeFile(focusChainFilePath, fileContent, "utf8")
	}

	return focusChainFilePath
}
