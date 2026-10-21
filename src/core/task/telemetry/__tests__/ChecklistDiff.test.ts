import { checklistItemId, diffChecklist, parseChecklist } from "../ChecklistDiff"

const list = (...lines: string[]): string => lines.join("\n")

describe("checklist parsing", () => {
    it("reads only checkbox lines and keeps their state", () => {
        const report = parseChecklist(
            list("# Plans", "", "Intro prose", "- [ ] first item", "* [x] second item", "- not an item"),
        )

        expect(report.items.map((item) => item.done)).toEqual([false, true])
        expect(report.items.map((item) => item.itemId)).toEqual([checklistItemId("first item"), checklistItemId("second item")])
    })

    it("identifies an item by its text rather than its position", () => {
        const before = parseChecklist(list("- [ ] alpha", "- [ ] beta"))
        const after = parseChecklist(list("- [ ] beta", "- [ ] alpha"))

        // Reordering is not a change: identity follows the wording.
        expect(after.items[0]?.itemId).toBe(before.items[1]?.itemId)
        expect(diffChecklist(before, after)).toEqual([])
    })

    it("counts an item written twice once", () => {
        const report = parseChecklist(list("- [ ] repeated", "- [x] repeated"))

        expect(report.items).toHaveLength(1)
    })

    it("never exposes the item text in its identity", () => {
        expect(checklistItemId("secret plan wording")).not.toContain("secret")
    })
})

describe("checklist differences", () => {
    it("declares every item of a first report without inventing completions", () => {
        const changes = diffChecklist(undefined, parseChecklist(list("- [ ] open", "- [x] done")))

        expect(changes.map((change) => change.transition)).toEqual(["declared", "declared"])
    })

    it("reports checking and unchecking as completion and reopen", () => {
        const before = parseChecklist(list("- [ ] item"))
        const completed = diffChecklist(before, parseChecklist(list("- [x] item")))

        expect(completed).toEqual([{ itemId: checklistItemId("item"), transition: "completed" }])

        const reopened = diffChecklist(parseChecklist(list("- [x] item")), parseChecklist(list("- [ ] item")))

        expect(reopened).toEqual([{ itemId: checklistItemId("item"), transition: "reopened" }])
    })

    it("reports a dropped item as abandoned and a new one as declared", () => {
        const changes = diffChecklist(parseChecklist(list("- [ ] gone")), parseChecklist(list("- [ ] added")))

        expect(changes).toEqual([
            { itemId: checklistItemId("added"), transition: "declared" },
            { itemId: checklistItemId("gone"), transition: "abandoned" },
        ])
    })

    it("treats reworded text as a different item instead of a reopen", () => {
        const changes = diffChecklist(parseChecklist(list("- [x] old wording")), parseChecklist(list("- [ ] new wording")))

        expect(changes).toEqual([
            { itemId: checklistItemId("new wording"), transition: "declared" },
            { itemId: checklistItemId("old wording"), transition: "abandoned" },
        ])
    })

    it("reports nothing when the checklist did not change", () => {
        const report = parseChecklist(list("- [ ] a", "- [x] b"))

        expect(diffChecklist(report, report)).toEqual([])
    })
})
