import { describe, expect, it } from "vitest"
import type { Controller } from "../index"
import { coalesceCapabilityScan } from "./refresh-coalescing"

function createController(): Controller {
    return {} as Controller
}

describe("coalesceCapabilityScan", () => {
    it("runs one scan for concurrent callers and gives them the same result", async () => {
        const controller = createController()
        let scans = 0
        let release: ((value: string) => void) | undefined
        const scan = () => {
            scans++
            return new Promise<string>((resolve) => {
                release = resolve
            })
        }

        const first = coalesceCapabilityScan(controller, "rules", scan)
        const second = coalesceCapabilityScan(controller, "rules", scan)
        release?.("scanned")

        expect(scans).toBe(1)
        await expect(first).resolves.toBe("scanned")
        await expect(second).resolves.toBe("scanned")
    })

    it("releases the slot so a later caller observes current disk state", async () => {
        const controller = createController()
        let scans = 0
        const scan = () => {
            scans++
            return Promise.resolve(scans)
        }

        await expect(coalesceCapabilityScan(controller, "rules", scan)).resolves.toBe(1)
        await expect(coalesceCapabilityScan(controller, "rules", scan)).resolves.toBe(2)
    })

    it("releases the slot after a failed scan instead of caching the rejection", async () => {
        const controller = createController()
        let attempts = 0
        const scan = () => {
            attempts++
            return attempts === 1 ? Promise.reject(new Error("scan failed")) : Promise.resolve("recovered")
        }

        await expect(coalesceCapabilityScan(controller, "rules", scan)).rejects.toThrow("scan failed")
        await expect(coalesceCapabilityScan(controller, "rules", scan)).resolves.toBe("recovered")
    })

    it("keeps different scan keys and different controllers independent", async () => {
        const controller = createController()
        const otherController = createController()
        const pending = new Map<string, (value: string) => void>()
        const scanFor = (label: string) => () =>
            new Promise<string>((resolve) => {
                pending.set(label, resolve)
            })

        const rules = coalesceCapabilityScan(controller, "rules", scanFor("rules"))
        const skills = coalesceCapabilityScan(controller, "skills", scanFor("skills"))
        const otherRules = coalesceCapabilityScan(otherController, "rules", scanFor("other-rules"))

        expect(pending.size).toBe(3)
        pending.get("rules")?.("rules")
        pending.get("skills")?.("skills")
        pending.get("other-rules")?.("other-rules")

        await expect(rules).resolves.toBe("rules")
        await expect(skills).resolves.toBe("skills")
        await expect(otherRules).resolves.toBe("other-rules")
    })
})
