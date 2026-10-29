import path from "node:path"
import { describe, expect, it } from "vitest"
import { capabilityResourceId } from "../capability-resource-id"
import { activeCapabilityScope, resolveToggle, resolveToggles } from "../capability-toggle-scopes"

const RAW_PATH = path.resolve("E:/ws/.agents/skills/review/SKILL.md")
const STORED_ID = capabilityResourceId(RAW_PATH)

describe("resolveToggle", () => {
    it("applies an override stored under the normalized resource id", () => {
        // The write path stores capabilityResourceId(...), while discovery reports
        // the raw scan path. Looking up the raw path alone would miss the override
        // and silently keep the resource enabled.
        expect(resolveToggle(RAW_PATH, true, { workspace: { [STORED_ID]: false } })).toBe(false)
    })

    it("falls back to the discovered default when no scope has an opinion", () => {
        expect(resolveToggle(RAW_PATH, true, { workspace: {} })).toBe(true)
        expect(resolveToggle(RAW_PATH, false, {})).toBe(false)
    })

    it("lets a task override win over workspace and global", () => {
        const scopes = {
            global: { [STORED_ID]: false },
            workspace: { [STORED_ID]: false },
            task: { [STORED_ID]: true },
        }
        expect(resolveToggle(RAW_PATH, false, scopes)).toBe(true)
    })

    it("lets a workspace override win over global", () => {
        const scopes = { global: { [STORED_ID]: true }, workspace: { [STORED_ID]: false } }
        expect(resolveToggle(RAW_PATH, true, scopes)).toBe(false)
    })
})

describe("resolveToggles", () => {
    it("keeps the discovered keys so callers can map back onto scanned items", () => {
        const resolved = resolveToggles({ [RAW_PATH]: true }, { workspace: { [STORED_ID]: false } })

        expect(Object.keys(resolved)).toEqual([RAW_PATH])
        expect(resolved[RAW_PATH]).toBe(false)
    })
})

describe("activeCapabilityScope", () => {
    it("selects the innermost scope the editor is currently in", () => {
        expect(activeCapabilityScope({ hasWorkspace: false, hasTask: false })).toBe("global")
        expect(activeCapabilityScope({ hasWorkspace: true, hasTask: false })).toBe("workspace")
        expect(activeCapabilityScope({ hasWorkspace: true, hasTask: true })).toBe("task")
    })
})
