import type { IntakeEntry } from "../kernel"

export type IntakeAdmissionPoint = "tool_round" | "turn_end"

export function selectIntakeEntries(entries: readonly IntakeEntry[], point: IntakeAdmissionPoint): readonly IntakeEntry[] {
    const eligible = entries.filter((entry) => entry.state === "accepted")
    const steering = eligible.filter((entry) => entry.mode === "steering").sort((left, right) => left.sequence - right.sequence)
    if (point === "tool_round") return steering
    const queued = eligible.filter((entry) => entry.mode === "queued").sort((left, right) => left.sequence - right.sequence)
    return [...steering, ...queued]
}
