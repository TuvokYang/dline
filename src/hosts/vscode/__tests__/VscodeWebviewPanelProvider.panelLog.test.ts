import { readFile } from "node:fs/promises"
import path from "node:path"
import { describe, expect, it } from "vitest"

/**
 * `Panel created: undefined` was reported as a defect, but it is not one: a
 * panel opened for a new task has no task id yet, and the id arrives later
 * through setPendingTaskId. The log printed the raw value, so an ordinary
 * state was indistinguishable from a lost identifier and sent the
 * investigation after a symptom that did not exist.
 *
 * This is asserted against the source rather than through a running panel:
 * the message is produced inside VSCode panel construction, which a unit test
 * cannot stand up. What matters is that the two cases are named separately,
 * and that no other code reads the old text.
 */

const providerSourcePath = path.resolve(__dirname, "../VscodeWebviewPanelProvider.ts")

describe("panel creation log semantics", () => {
    it("never interpolates a possibly-undefined task id into the creation message", async () => {
        const source = await readFile(providerSourcePath, "utf8")

        expect(source).not.toContain("Panel created: ${this.pendingTaskId}")
    })

    it("names the new-task case without claiming a missing id", async () => {
        const source = await readFile(providerSourcePath, "utf8")

        expect(source).toContain("Panel created for a new task; task id pending")
    })

    it("names the bound task when the panel already has one", async () => {
        const source = await readFile(providerSourcePath, "utf8")

        expect(source).toContain("Panel created for task ${this.pendingTaskId}")
    })

    /**
     * The branch has to be on the id itself. A message that merely reworded the
     * old line would still render `undefined` for the common case.
     */
    it("selects the message from whether a task id is present", async () => {
        const source = await readFile(providerSourcePath, "utf8")

        expect(source).toContain("this.pendingTaskId === undefined")
    })

    /**
     * Restoration already distinguishes its own outcomes. Those messages are
     * what a reader compares against when deciding whether a panel was created
     * fresh or rebuilt, so they must not be collapsed into the creation log.
     */
    it("keeps the restoration messages distinct from creation", async () => {
        const source = await readFile(providerSourcePath, "utf8")

        expect(source).toContain("Restored panel without task (blank state)")
        expect(source).toContain("Restoring panel for task ${taskId}")
    })
})

describe("panel creation log consumers", () => {
    /**
     * A log line is only safe to reword when nothing parses it. This checks the
     * extension sources for a dependency on the old text.
     */
    it("has no source outside the provider that matches on the old message", async () => {
        const { globby } = await import("globby")
        const repoRoot = path.resolve(__dirname, "../../../..")
        const files = await globby(["src/**/*.ts", "webview-ui/src/**/*.ts", "webview-ui/src/**/*.tsx"], {
            cwd: repoRoot,
            absolute: true,
            gitignore: true,
        })

        const offenders: string[] = []
        for (const file of files) {
            if (file.endsWith("VscodeWebviewPanelProvider.panelLog.test.ts")) {
                continue
            }
            const contents = await readFile(file, "utf8")
            if (contents.includes("Panel created:")) {
                offenders.push(path.relative(repoRoot, file))
            }
        }

        expect(offenders).toEqual([])
    })
})
