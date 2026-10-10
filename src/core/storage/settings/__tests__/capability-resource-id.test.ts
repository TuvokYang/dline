import * as path from "node:path"
import { capabilityResourceId } from "@core/storage/settings/capability-resource-id"
import { describe, expect, it } from "vitest"

const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin"

describe("capabilityResourceId", () => {
    const root = path.resolve("ws")

    it("collapses separator differences for the same file", () => {
        const withBackslashes = capabilityResourceId(path.join(root, ".clinerules", "a.md"), root)
        const withSlashes = capabilityResourceId(`${root}/.clinerules/a.md`, root)

        expect(withBackslashes).toBe(withSlashes)
        expect(withBackslashes).toBe(CASE_INSENSITIVE ? ".clinerules/a.md" : ".clinerules/a.md")
    })

    it("follows the platform's case sensitivity", () => {
        const lower = capabilityResourceId(path.join(root, ".clinerules", "a.md"), root)
        const upper = capabilityResourceId(path.join(root, ".clinerules", "A.MD"), root)

        if (CASE_INSENSITIVE) {
            // A case-only difference must not look like a different resource,
            // otherwise the preference resets whenever the scan reports the
            // other spelling.
            expect(upper).toBe(lower)
        } else {
            expect(upper).not.toBe(lower)
        }
    })

    it("resolves relative and absolute forms of the same file to one id", () => {
        const absolute = capabilityResourceId(path.join(root, "skills", "s.md"), root)
        const relative = capabilityResourceId(path.join("ws", "skills", "s.md"), root)

        expect(relative).toBe(absolute)
    })

    it("drops a trailing separator", () => {
        expect(capabilityResourceId(path.join(root, "skills"), root)).toBe(capabilityResourceId(`${root}/skills/`, root))
    })

    it("keeps the absolute form for paths outside the root", () => {
        const outside = path.resolve("other", "rules", "b.md")

        // A "../.." style id would depend on the root's depth, so two different
        // roots would produce different keys for the same file.
        expect(capabilityResourceId(outside, root)).not.toContain("..")
        expect(capabilityResourceId(outside, root)).toBe(capabilityResourceId(outside))
    })

    it("keeps remote resources addressed by name", () => {
        expect(capabilityResourceId("remote:Team Skill", root)).toBe(CASE_INSENSITIVE ? "remote:team skill" : "remote:Team Skill")
    })

    it("returns an empty id for blank input", () => {
        expect(capabilityResourceId("   ")).toBe("")
    })
})
