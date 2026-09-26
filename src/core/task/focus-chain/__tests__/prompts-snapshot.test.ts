/**
 * Focus Chain Prompts Snapshot Tests
 *
 * Captures the full output of every focus chain prompt variant so that
 * changes to rejection messages, instructions, or formatting are caught
 * by snapshot diffs during code review.
 *
 * Uses manual snapshot files (*.snap) in __snapshots__/ directory,
 * following the same pattern as system-prompt integration tests.
 * Set UPDATE_SNAPSHOTS=true env to regenerate snapshot files.
 */

import * as fs from "node:fs/promises"
import * as path from "node:path"
import { assertPromptContent } from "@core/prompts/system-prompt/__tests__/snapshot-content"
import { describe, it } from "vitest"
import { FocusChainPrompts } from "../prompts"

const UPDATE = process.env.UPDATE_SNAPSHOTS === "true"
const SNAP_DIR = path.join(__dirname, "__snapshots__")
const SNAP_FILE = path.join(SNAP_DIR, "prompts-snapshot.snap")

// Simple string diff for mismatch reporting
function diffLines(a: string, b: string): string | null {
	if (a === b) return null
	const aLines = a.split("\n")
	const bLines = b.split("\n")
	const diffs: string[] = []
	for (let i = 0; i < Math.max(aLines.length, bLines.length) && diffs.length < 8; i++) {
		const ae = aLines[i] || ""
		const be = bLines[i] || ""
		if (ae !== be) {
			diffs.push(`  Line ${i + 1}:`)
			if (ae) diffs.push(`    - ${ae.slice(0, 100)}`)
			if (be) diffs.push(`    + ${be.slice(0, 100)}`)
		}
	}
	return diffs.join("\n")
}

/** Read the existing .snap file and return parsed entries as { [title]: content } */
async function readSnapshots(): Promise<Record<string, string>> {
	try {
		const raw = await fs.readFile(SNAP_FILE, "utf-8")
		const entries: Record<string, string> = {}
		const blocks = raw.split(/\n(?=### )/)
		for (const block of blocks) {
			const match = block.match(/^### (.+)\n([\s\S]*)$/)
			if (match) {
				// Preserve trailing newline for correct diffing
				entries[match[1].trim()] = match[2].replace(/\n$/, "")
			}
		}
		return entries
	} catch {
		return {}
	}
}

/** Assert snapshot match; if UPDATE=true, write entries to .snap file */
async function assertSnapshot(title: string, content: string): Promise<void> {
	assertPromptContent(title, content)
	if (UPDATE) {
		await updateSnapshot(title, content)
		return
	}
	const entries = await readSnapshots()
	const expected = entries[title]
	if (expected === undefined) {
		throw new Error(`Snapshot "${title}" not found. Run with UPDATE_SNAPSHOTS=true to generate.`)
	}
	const diff = diffLines(expected, content)
	if (diff) {
		throw new Error(`Snapshot mismatch for "${title}":\n${diff}\n\nRun with UPDATE_SNAPSHOTS=true to update.`)
	}
}

/** Write a single entry back into the .snap file, preserving others via readSnapshots */
async function updateSnapshot(title: string, content: string): Promise<void> {
	const entries = await readSnapshots()
	entries[title] = content
	const sorted = Object.keys(entries).sort()
	const blocks = sorted.map((k) => `### ${k}\n${entries[k]}`)
	await fs.mkdir(SNAP_DIR, { recursive: true })
	await fs.writeFile(SNAP_FILE, `${blocks.join("\n\n")}\n`, "utf-8")
	console.log(`  \u2713 Updated snapshot: ${title}`)
}

// Fixtures shared across tests
const SAMPLE_UNCHECKED = ["- [ ] Create login component", "- [ ] Add form validation", "- [ ] Wire up API call"]

describe("Focus Chain Prompt Snapshots", () => {
	// ── Forward-looking / creation prompts ──────────────────────────

	it("initial — PLAN \u2192 ACT switch", async () => {
		await assertSnapshot("initial", FocusChainPrompts.initial)
	})

	it("recommended — first-time checklist", async () => {
		await assertSnapshot("recommended", FocusChainPrompts.recommended)
	})

	it("planModeReminder", async () => {
		await assertSnapshot("planModeReminder", FocusChainPrompts.planModeReminder)
	})

	// ── Progress / working-state prompts ────────────────────────────

	it("reminder — during work", async () => {
		await assertSnapshot("reminder", FocusChainPrompts.reminder)
	})

	it("completed — all items done", async () => {
		await assertSnapshot("completed", FocusChainPrompts.completed(6))
	})

	it("apiRequestCount — too many requests without checklist", async () => {
		const count = 42
		await assertSnapshot("apiRequestCount", FocusChainPrompts.apiRequestCount(count))
	})

	// ── Rejection prompts (tampering / skip-order) ──────────────────

	it("tamperingRejected", async () => {
		await assertSnapshot("tamperingRejected", FocusChainPrompts.tamperingRejected)
	})

	it("titleRequired", async () => {
		await assertSnapshot("titleRequired", FocusChainPrompts.titleRequired)
	})

	it("uncheckedItemRequired", async () => {
		await assertSnapshot("uncheckedItemRequired", FocusChainPrompts.uncheckedItemRequired)
	})

	it("skipOrderWarning", async () => {
		await assertSnapshot("skipOrderWarning", FocusChainPrompts.skipOrderWarning)
	})

	it("skipOrderRejected — with examples", async () => {
		const exampleStr = SAMPLE_UNCHECKED.join("\n")
		await assertSnapshot("skipOrderRejected", FocusChainPrompts.skipOrderRejected(exampleStr))
	})

	// ── Item-mismatch rejection prompts ─────────────────────────────

	it("itemMismatchRejected — with unmatched items + examples", async () => {
		const unmatched = ["Fake item A", "Fake item B"]
		const exampleStr = SAMPLE_UNCHECKED.slice(0, 2).join("\n")
		const msg = FocusChainPrompts.itemMismatchRejected(unmatched.map((i) => `- ${i}`).join("\n"), exampleStr)
		await assertSnapshot("itemMismatchRejected", msg)
	})

	it("inProgressMismatchRejected — with examples", async () => {
		const exampleStr = SAMPLE_UNCHECKED.slice(0, 2).join("\n")
		await assertSnapshot("inProgressMismatchRejected", FocusChainPrompts.inProgressMismatchRejected(exampleStr))
	})

	// ── Blocking / terminal-state prompts ───────────────────────────

	it("allCompletedAlready", async () => {
		await assertSnapshot("allCompletedAlready", FocusChainPrompts.allCompletedAlready)
	})

	it("attemptCompletionBlocked", async () => {
		await assertSnapshot("attemptCompletionBlocked", FocusChainPrompts.attemptCompletionBlocked)
	})
})
