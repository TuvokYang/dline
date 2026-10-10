import { expect } from "chai"

/**
 * Clean approvedPlan for focus chain file:
 * - Remove "[-] - " lines (rejected items)
 * - Convert "[+] - " prefix to "- [ ] " (approved items)
 * - Remove empty section headings
 * - Keep "- [x]" lines as-is (already completed)
 * - Keep "# Title" lines
 */
function cleanForFocusChain(approvedPlan: string): string {
    const lines = approvedPlan.split("\n")
    const result: string[] = []
    let pendingHeading: string | null = null

    for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed.startsWith("## ")) {
            // New heading replaces any pending one that had no items (empty section discarded)
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
    // pendingHeading with no following items is discarded
    return result.join("\n")
}

describe("FocusChainHandler clean logic", () => {
    it("removes [-] lines and keeps [+] lines converted to [ ]", () => {
        const input = [
            "# Test Plan",
            "## Section A",
            "[+] - [ ] selected item",
            "[-] - [ ] rejected item",
            "[+] - [ ] another selected",
            "## Section B",
            "[-] - [ ] all rejected",
        ].join("\n")
        const result = cleanForFocusChain(input)
        expect(result).to.include("- [ ] selected item")
        expect(result).to.include("- [ ] another selected")
        expect(result).not.to.include("[-]")
        expect(result).not.to.include("[+]")
        expect(result).not.to.include("rejected item")
        expect(result).not.to.include("all rejected")
    })

    it("removes empty section headings", () => {
        const input = [
            "# Test Plan",
            "## Section A",
            "[+] - [ ] item 1",
            "## Section B",
            "[-] - [ ] rejected",
            "## Section C",
            "[+] - [ ] item 2",
        ].join("\n")
        const result = cleanForFocusChain(input)
        // Section B should be removed (all items rejected)
        expect(result).to.include("## Section A")
        expect(result).not.to.include("## Section B")
        expect(result).to.include("## Section C")
    })

    it("preserves - [x] lines as-is", () => {
        const input = ["# Test Plan", "## Tasks", "- [x] already done", "[+] - [ ] new selected", "[-] - [ ] new rejected"].join(
            "\n",
        )
        const result = cleanForFocusChain(input)
        expect(result).to.include("- [x] already done")
        expect(result).to.include("- [ ] new selected")
        expect(result).not.to.include("new rejected")
    })

    it("handles plan with only selected items (no rejections)", () => {
        const input = ["# Test Plan", "## Section A", "[+] - [ ] item 1", "[+] - [ ] item 2"].join("\n")
        const result = cleanForFocusChain(input)
        expect(result).to.include("- [ ] item 1")
        expect(result).to.include("- [ ] item 2")
        expect(result).not.to.include("[+]")
    })

    it("handles plan with only rejected items", () => {
        const input = ["# Test Plan", "## Section A", "[-] - [ ] item 1", "[-] - [ ] item 2"].join("\n")
        const result = cleanForFocusChain(input)
        expect(result).to.include("# Test Plan")
        expect(result).not.to.include("## Section A") // empty section removed
        expect(result).not.to.include("item 1")
        expect(result).not.to.include("item 2")
    })

    it("does not match partial [-] inside text", () => {
        const input = ["# Test Plan", "## Section", "[+] - [ ] item with [-] in name"].join("\n")
        const result = cleanForFocusChain(input)
        expect(result).to.include("item with [-] in name")
        expect(result).not.to.include("[+]")
    })
})
