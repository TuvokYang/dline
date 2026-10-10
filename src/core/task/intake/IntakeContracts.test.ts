import { describe, expect, it } from "vitest"
import type { IntakeEntry } from "../kernel"
import { selectIntakeEntries } from "./IntakeAdmission"

const entry = (
    entryId: string,
    mode: IntakeEntry["mode"],
    sequence: number,
    state: IntakeEntry["state"] = "accepted",
): IntakeEntry => ({
    entryId,
    payloadRef: `payload:${entryId}`,
    source: "user",
    mode,
    sequence,
    state,
})

describe("intake contracts", () => {
    it("preserves steering priority, sequence order and turn-end queued admission", () => {
        const entries = [
            entry("queued-2", "queued", 2),
            entry("steering-3", "steering", 3),
            entry("steering-1", "steering", 1),
            entry("released", "steering", 0, "released"),
        ]
        expect(selectIntakeEntries(entries, "tool_round").map((item) => item.entryId)).toEqual(["steering-1", "steering-3"])
        expect(selectIntakeEntries(entries, "turn_end").map((item) => item.entryId)).toEqual([
            "steering-1",
            "steering-3",
            "queued-2",
        ])
    })
})
