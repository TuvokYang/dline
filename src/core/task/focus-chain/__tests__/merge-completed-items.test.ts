/**
 * Tests for mergeCompletedItems — idempotent handling fixes.
 *
 * Covers the edge case where AI reports - [x] items that are already
 * marked as [x] in the checklist (idempotent progress reports).
 * Previously these were incorrectly flagged as "unmatched" (fabricated progress).
 */

import { describe, expect, it } from "vitest"
import {
    formatFocusChainTaskProgressSection,
    getUncheckedFocusChainItemAtIndex,
    hasValidTodoItem,
    mergeCompletedItems,
    mergeInProgressItem,
} from "../file-utils"

/**
 * Helper: build a simple checklist with sections and items.
 */
function makeChecklist(items: Array<{ done: boolean; text: string }>, sections = false): string {
    let result = "# Test Plan\n"
    if (sections) result += "## Phase 1\n"
    for (const item of items) {
        result += item.done ? `- [x] ${item.text}\n` : `- [ ] ${item.text}\n`
    }
    return result.trimEnd()
}

/**
 * Build a report string (as AI would send via task_progress).
 */
function report(...texts: string[]): string {
    return texts.map((t) => `- [x] ${t}`).join("\n")
}

describe("hasValidTodoItem", () => {
    it.each([
        undefined,
        "",
        "  \n\t",
        "# Empty plan\n## Phase",
        "- [ ]",
        "- [x]   ",
    ])("rejects missing or structurally empty TODO content: %j", (value) => {
        expect(hasValidTodoItem(value ?? "")).toBe(false)
    })

    it.each(["- [ ] Pending", "- [x] Done", "# Plan\n- [ ] Pending"])("accepts a TODO item with text: %j", (value) => {
        expect(hasValidTodoItem(value)).toBe(true)
    })
})

describe("mergeCompletedItems", () => {
    it("should match reported completed items to unchecked checklist items", () => {
        const checklist = makeChecklist([
            { done: false, text: "Task 1: setup project" },
            { done: false, text: "Task 2: implement core" },
        ])
        const result = mergeCompletedItems(checklist, report("Task 1: setup project"))

        expect(result.unmatchedItems).toEqual([])
        expect(result.mergedText).toContain("- [x] Task 1: setup project")
        expect(result.mergedText).toContain("- [ ] Task 2: implement core")
    })

    it("should report unmatched when item text differs", () => {
        const checklist = makeChecklist([{ done: false, text: "Task 1: setup project" }])
        const result = mergeCompletedItems(checklist, report("Task 1: setup project differently"))

        expect(result.unmatchedItems).toEqual(["Task 1: setup project differently"])
    })

    it("should NOT report unmatched for idempotent reports (already [x])", () => {
        const checklist = makeChecklist([
            { done: true, text: "Task 1: setup project" },
            { done: true, text: "Task 2: implement core" },
        ])
        const result = mergeCompletedItems(checklist, report("Task 1: setup project", "Task 2: implement core"))

        // Previously these would be unmatched because all items were already [x]
        expect(result.unmatchedItems).toEqual([])
    })

    it("should handle mixed state: some already [x], some [ ]", () => {
        const checklist = makeChecklist([
            { done: true, text: "Task 1: setup project" },
            { done: false, text: "Task 2: implement core" },
        ])
        const result = mergeCompletedItems(checklist, report("Task 1: setup project", "Task 2: implement core"))

        // Task 1 already [x] → idempotent (no unmatched)
        // Task 2 still [ ] → matched and marked [x]
        expect(result.unmatchedItems).toEqual([])
        expect(result.mergedText).toContain("- [x] Task 1: setup project")
        expect(result.mergedText).toContain("- [x] Task 2: implement core")
    })

    it("should still flag truly unmatched items even when idempotent items exist", () => {
        const checklist = makeChecklist([
            { done: true, text: "Task 1: setup project" },
            { done: false, text: "Task 2: implement core" },
        ])
        const result = mergeCompletedItems(checklist, report("Task 1: setup project", "Fake Task: nonexistent"))

        // Task 1 idempotent → ok
        // Fake Task → truly unmatched
        expect(result.unmatchedItems).toEqual(["Fake Task: nonexistent"])
    })

    it("should handle section headings correctly", () => {
        const checklist = makeChecklist(
            [
                { done: true, text: "Task 1: setup" },
                { done: false, text: "Task 2: implement" },
            ],
            true, // with ## sections
        )
        const result = mergeCompletedItems(checklist, report("Task 1: setup", "Task 2: implement"))

        expect(result.unmatchedItems).toEqual([])
        expect(result.mergedText).toContain("- [x] Task 1: setup")
        expect(result.mergedText).toContain("- [x] Task 2: implement")
        // Sections should be preserved
        expect(result.mergedText).toContain("## Phase 1")
    })

    it("should preserve indentation in merged output", () => {
        const checklist = "  - [ ] Indented task"
        const result = mergeCompletedItems(checklist, report("Indented task"))

        expect(result.unmatchedItems).toEqual([])
        expect(result.mergedText).toBe("  - [x] Indented task")
    })

    it("should handle all items already [x] with sections gracefully", () => {
        const checklist = `# Build API Key Store Separation\n## Phase 1\n- [x] Task 1: getApiProfiles.ts\n- [x] Task 2: updateApiProfiles.ts\n## Phase 2\n- [x] Task 3: api/index.ts`
        const result = mergeCompletedItems(
            checklist,
            report("Task 1: getApiProfiles.ts", "Task 2: updateApiProfiles.ts", "Task 3: api/index.ts"),
        )

        // All items already [x] → idempotent, no unmatched
        expect(result.unmatchedItems).toEqual([])
    })
})

describe("mergeInProgressItem", () => {
    it("should return matchedItemIndex for the in-progress item", () => {
        const checklist = `- [x] Task 1: done\n- [ ] Task 2: current\n- [ ] Task 3: pending`
        const result = mergeInProgressItem(checklist, "- [ ] Task 2: current")

        expect(result.matchedItem).toBe("- [ ] Task 2: current")
        expect(result.matchedItemIndex).toBe(1) // 0-based: Task 1 is index 0, Task 2 is index 1
        // Checklist text stays clean — <- CURRENT is rendered only in environment_details
        expect(result.updatedText).toContain("- [ ] Task 2: current")
    })

    it("should skip completed items when computing index", () => {
        const checklist = `- [x] Task 1\n- [x] Task 2\n- [ ] Task 3\n- [ ] Task 4`
        const result = mergeInProgressItem(checklist, "- [ ] Task 3")

        expect(result.matchedItemIndex).toBe(2) // skipped index 0 and 1
    })

    it("should return null index and text when no match", () => {
        const checklist = `- [ ] Task 1\n- [ ] Task 2`
        const result = mergeInProgressItem(checklist, "- [ ] Non-existent")

        expect(result.matchedItem).toBeNull()
        expect(result.matchedItemIndex).toBeNull()
        expect(result.updatedText).toBeNull()
    })
})

describe("focus chain current-item projection", () => {
    const checklist = `# Test Plan\n## Work\n- [x] Inspect prompts\n- [ ] Update projection\n- [ ] Run tests`

    it("returns only an unchecked item for a valid current index", () => {
        expect(getUncheckedFocusChainItemAtIndex(checklist, 1)).toBe("- [ ] Update projection")
    })

    it.each([0, 3, -1, null])("rejects completed, out-of-range, or absent current indexes: %s", (itemIndex) => {
        expect(getUncheckedFocusChainItemAtIndex(checklist, itemIndex)).toBeNull()
    })

    it("renders CURRENT as separate metadata without mutating the checklist item", () => {
        const section = formatFocusChainTaskProgressSection(checklist, 1)

        expect(section).toBe(`${"# task_progress"}\n${checklist}\n\nCURRENT:\n- [ ] Update projection`)
        expect(section).not.toContain("<- CURRENT")
        expect(section).not.toContain("Update projection CURRENT")
    })

    it("omits CURRENT when the stored index points to a completed item", () => {
        const section = formatFocusChainTaskProgressSection(checklist, 0)

        expect(section).toBe(`${"# task_progress"}\n${checklist}`)
        expect(section).not.toContain("CURRENT:")
    })
})
