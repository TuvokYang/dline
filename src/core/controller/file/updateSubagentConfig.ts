/**
 * Handler for updateSubagentConfig RPC.
 *
 * Updates a subagent YAML configuration file in-place.
 * Supports incremental updates: scalar fields use proto presence, while
 * repeated fields require an explicit replacement intent.
 */
import { sanitizeSubagentToolsForPersistence } from "@core/task/tools/subagent/subagent-tool-policy"
import { Empty } from "@shared/proto/dline/common"
import { UpdateSubagentConfigRequest } from "@shared/proto/dline/file"
import { Logger } from "@shared/services/Logger"
import fs from "fs/promises"
import type { Controller } from ".."

/**
 * Update a subagent YAML config file.
 *
 * Modifies frontmatter fields (profile, tools, skills, description)
 * while preserving the system prompt body and comments.
 */
export async function updateSubagentConfig(controller: Controller, request: UpdateSubagentConfigRequest): Promise<Empty> {
	const { subagentPath, profile, tools, skills, description, replaceTools, replaceSkills } = request

	if (!subagentPath) {
		throw new Error("subagentPath is required")
	}

	// Read the current file content
	let content: string
	try {
		content = await fs.readFile(subagentPath, "utf8")
	} catch (err) {
		Logger.error(`[updateSubagentConfig] Failed to read subagent file: ${subagentPath}`, err)
		throw new Error(`Failed to read subagent file: ${subagentPath}`)
	}

	// Find frontmatter boundaries
	const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/)
	if (!frontmatterMatch) {
		throw new Error(`No YAML frontmatter found in: ${subagentPath}`)
	}

	const frontmatterStart = content.indexOf("---")
	const frontmatterEnd = content.indexOf("---", frontmatterStart + 3) + 3
	const beforeFrontmatter = content.slice(0, frontmatterStart)
	const frontmatterBody = content.slice(frontmatterStart + 3, frontmatterEnd - 3)
	const afterFrontmatter = content.slice(frontmatterEnd)

	let updatedFrontmatter = frontmatterBody

	// Update profile if provided (set to empty string to remove)
	if (profile !== undefined) {
		updatedFrontmatter = upsertYamlField(updatedFrontmatter, "profile", profile || null)
	}

	// Repeated proto fields default to empty arrays, so replacement intent must
	// be explicit to distinguish "preserve" from "clear this list".
	//
	// Either way the stored list is brought in line with the policy. The
	// selection UI hides forbidden tools, but it is not an enforcement boundary:
	// this RPC is reachable directly, and a document edited by hand can already
	// contain a tool no save would have produced. Rewriting only on explicit
	// replacement would let such a document survive every unrelated edit.
	if (replaceTools) {
		updatedFrontmatter = upsertYamlListField(updatedFrontmatter, "tools", sanitizeSubagentToolsForPersistence(tools))
	} else {
		const existingTools = readYamlListField(updatedFrontmatter, "tools")
		if (existingTools) {
			const sanitized = sanitizeSubagentToolsForPersistence(existingTools)
			// Rewrite only on a real difference, so an untouched document keeps
			// its original formatting and comments.
			if (sanitized.length !== existingTools.length || sanitized.some((tool, i) => tool !== existingTools[i])) {
				updatedFrontmatter = upsertYamlListField(updatedFrontmatter, "tools", sanitized)
			}
		}
	}

	if (replaceSkills) {
		updatedFrontmatter = upsertYamlListField(updatedFrontmatter, "skills", skills)
	}

	// Update description if provided
	if (description !== undefined) {
		updatedFrontmatter = upsertYamlField(updatedFrontmatter, "description", description || null)
	}

	// Reconstruct the file with explicit line boundaries around YAML frontmatter.
	const normalizedFrontmatter = updatedFrontmatter.trim().replace(/\r?\n/g, "\n")
	const normalizedBody = afterFrontmatter.replace(/^\r?\n/, "")
	const newContent = `${beforeFrontmatter}---\n${normalizedFrontmatter}\n---\n${normalizedBody}`

	try {
		await fs.writeFile(subagentPath, newContent, "utf8")
		Logger.log(`[updateSubagentConfig] Updated subagent config: ${subagentPath}`)
	} catch (err) {
		Logger.error(`[updateSubagentConfig] Failed to write subagent file: ${subagentPath}`, err)
		throw new Error(`Failed to write subagent file: ${subagentPath}`)
	}

	if (controller.task) {
		await controller.task.flushPromptFreshnessInvalidation("capability_mutation")
	} else {
		await controller.postStateToWebview()
	}

	return Empty.create({})
}

/**
 * Upsert a scalar YAML field in the frontmatter.
 * If the field exists, replaces its value. If not, appends it.
 * Pass null for value to remove the field.
 */
function upsertYamlField(frontmatter: string, fieldName: string, value: string | null): string {
	const lines = frontmatter.split("\n")
	const fieldRegex = new RegExp(`^\\s*${escapeRegex(fieldName)}\\s*:`)

	// Remove existing field occurrences
	const filtered = lines.filter((line) => !fieldRegex.test(line))

	if (value === null) {
		// Field removed
		return filtered.join("\n")
	}

	// Find insertion point: after the last non-empty line before other fields
	// Simple strategy: append after the last field
	const trimmed = filtered.filter((l) => l.trim() !== "")

	// Insert alphabetically or at end — for simplicity, append at end
	const newLine = `${fieldName}: ${escapeYamlValue(value)}`

	return [...trimmed, newLine].join("\n")
}

/**
 * Read a YAML list field from the frontmatter.
 *
 * Handles the two shapes this document uses: an inline `field: []` and a block
 * of `  - item` lines. Returns undefined when the field is absent, which is
 * distinct from an empty list — absent means the caller should not write the
 * field at all.
 *
 * @returns Item values, or undefined when the field does not exist.
 */
function readYamlListField(frontmatter: string, fieldName: string): string[] | undefined {
	const lines = frontmatter.split("\n")
	const fieldRegex = new RegExp(`^\\s*${escapeRegex(fieldName)}\\s*:`)
	const fieldIndex = lines.findIndex((line) => fieldRegex.test(line))
	if (fieldIndex === -1) return undefined

	const inlineValue = lines[fieldIndex].slice(lines[fieldIndex].indexOf(":") + 1).trim()
	if (inlineValue === "[]") return []
	if (inlineValue.startsWith("[") && inlineValue.endsWith("]")) {
		return inlineValue
			.slice(1, -1)
			.split(",")
			.map((item) => unquoteYamlValue(item.trim()))
			.filter((item) => item.length > 0)
	}

	const items: string[] = []
	for (const line of lines.slice(fieldIndex + 1)) {
		const itemMatch = line.match(/^\s+-\s+(.*)$/)
		if (itemMatch) {
			items.push(unquoteYamlValue(itemMatch[1].trim()))
			continue
		}
		// A new top-level key ends the block; blank lines inside it are ignored.
		if (line.trim() === "") continue
		break
	}
	return items
}

/** Strip the quoting `escapeYamlValue` may have added. */
function unquoteYamlValue(value: string): string {
	if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
		return value.slice(1, -1).replace(/\\"/g, '"')
	}
	return value
}

/**
 * Upsert a YAML list field in the frontmatter.
 * Replaces the entire list with new values.
 */
function upsertYamlListField(frontmatter: string, fieldName: string, values: readonly string[]): string {
	const lines = frontmatter.split("\n")
	const fieldRegex = new RegExp(`^\\s*${escapeRegex(fieldName)}\\s*:`)

	// Find the start index of the field
	const fieldStartIndex = lines.findIndex((line) => fieldRegex.test(line))
	if (fieldStartIndex === -1) {
		// Field doesn't exist, append
		const newBlock =
			values.length > 0 ? [`${fieldName}:`, ...values.map((v) => `  - ${escapeYamlValue(v)}`)] : [`${fieldName}: []`]
		const nonEmpty = lines.filter((l) => l.trim() !== "")
		return [...nonEmpty, ...newBlock].join("\n")
	}

	// Remove existing field and its list items
	const beforeLines = lines.slice(0, fieldStartIndex)
	const afterStart = lines.slice(fieldStartIndex + 1)

	// Find where the list ends (next top-level field or end of frontmatter)
	let listEndIndex = 0
	for (let i = 0; i < afterStart.length; i++) {
		const line = afterStart[i]
		// List items start with "  - " or spaces
		if (line.match(/^\s{2}-\s/) || line.match(/^\s{4,}/)) {
			continue
		}
		// Top-level field found — list ends
		if (line.match(/^\s*\w+\s*:/) && !line.match(/^\s{2,}/)) {
			listEndIndex = i
			break
		}
		listEndIndex = i + 1
	}

	const afterLines = afterStart.slice(listEndIndex)

	// Build new list block
	const newBlock =
		values.length > 0 ? [`${fieldName}:`, ...values.map((v) => `  - ${escapeYamlValue(v)}`)] : [`${fieldName}: []`]

	return [...beforeLines, ...newBlock, ...afterLines].join("\n")
}

/**
 * Escape a string value for YAML single-line usage.
 */
function escapeYamlValue(value: string): string {
	// If value contains special characters, wrap in quotes
	if (/[:{}[\],&*?|!<>'"@`#]/.test(value) || value.includes(" ") || value === "") {
		return `"${value.replace(/"/g, '\\"')}"`
	}
	return value
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
