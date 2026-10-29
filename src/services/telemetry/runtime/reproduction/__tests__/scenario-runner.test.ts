import child_process from "node:child_process"
import fs from "node:fs"
import fsPromises from "node:fs/promises"
import http from "node:http"
import https from "node:https"
import net from "node:net"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ScenarioStep } from "../../export/bundle-builder"
import { countReplayedEffects, ReplayEffect, ReplayNotPermitted, ReplayPolicy, resolveReplayPort } from "../replay-ports"
import { classifyStepEffect, replayScenario } from "../scenario-runner"

function step(overrides: Partial<ScenarioStep> & Pick<ScenarioStep, "index" | "component">): ScenarioStep {
    return {
        operation: "run",
        outcome: "observed",
        offsetMs: 0,
        ...overrides,
    }
}

describe("classifyStepEffect", () => {
    it("maps known components to their effect category", () => {
        expect(classifyStepEffect("terminal")).toBe(ReplayEffect.Command)
        expect(classifyStepEffect("mcp")).toBe(ReplayEffect.McpTool)
        expect(classifyStepEffect("provider")).toBe(ReplayEffect.Network)
        expect(classifyStepEffect("checkpoint")).toBe(ReplayEffect.FileWrite)
    })

    it("classifies the snake_case component names this project actually emits", () => {
        // `PerfDomain` values are snake_case, and the bundle builder copies the
        // component attribute verbatim. A camelCase-only table would make every
        // self-produced bundle unreplayable.
        expect(classifyStepEffect("terminal_pool")).toBe(ReplayEffect.Command)
        expect(classifyStepEffect("settings_repository")).toBe(ReplayEffect.FileWrite)
        expect(classifyStepEffect("file_lock")).toBe(ReplayEffect.FileWrite)
        expect(classifyStepEffect("task_init")).toBe(ReplayEffect.Inert)
        expect(classifyStepEffect("prompt_build")).toBe(ReplayEffect.Inert)
    })

    it("classifies an unknown component as unknown rather than guessing", () => {
        // A newly instrumented domain — or a component name invented by a
        // hostile bundle — must not inherit the permissions of a reviewed
        // category.
        expect(classifyStepEffect("brand-new-domain")).toBe(ReplayEffect.Unknown)
    })

    it("does not resolve inherited object properties as effect categories", () => {
        // A scenario file arrives from an untrusted bug report. If the lookup
        // table were an object literal, these names would resolve through its
        // prototype chain to a function and escape the fail-closed branch.
        for (const hostile of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
            expect(classifyStepEffect(hostile)).toBe(ReplayEffect.Unknown)
        }
    })
})

describe("replayScenario", () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it("routes every step through the resolved port", () => {
        const steps = [
            step({ index: 0, component: "terminal", operation: "execute", outcome: "failed", durationMs: 1200 }),
            step({ index: 1, component: "mcp", operation: "callTool", outcome: "recovered", durationMs: 30 }),
        ]

        const report = replayScenario(steps, ReplayPolicy.Simulate)

        expect(report.port.requests).toHaveLength(2)
        expect(report.steps).toHaveLength(2)
        expect(report.totalRecordedDurationMs).toBe(1230)
    })

    it("performs no real command, tool, network, or file work", () => {
        // Spying on the actual effect surfaces means the assertion fails if a
        // future implementation grows a bypass, instead of only proving that a
        // cooperative fake reported `simulated`.
        const spies = [
            vi.spyOn(child_process, "spawn"),
            vi.spyOn(child_process, "spawnSync"),
            vi.spyOn(child_process, "exec"),
            vi.spyOn(child_process, "execSync"),
            vi.spyOn(child_process, "execFile"),
            vi.spyOn(child_process, "execFileSync"),
            vi.spyOn(fs, "writeFileSync"),
            vi.spyOn(fs, "appendFileSync"),
            vi.spyOn(fs, "createWriteStream"),
            vi.spyOn(fsPromises, "writeFile"),
            vi.spyOn(fsPromises, "appendFile"),
            vi.spyOn(fsPromises, "rm"),
            vi.spyOn(net, "connect"),
            vi.spyOn(http, "request"),
            vi.spyOn(https, "request"),
            vi.spyOn(globalThis, "fetch"),
        ]

        const steps = [
            step({ index: 0, component: "terminal", operation: "execute", outcome: "failed" }),
            step({ index: 1, component: "mcp", operation: "callTool", outcome: "failed" }),
            step({ index: 2, component: "provider", operation: "stream", outcome: "failed" }),
            step({ index: 3, component: "checkpoint", operation: "commit", outcome: "failed" }),
        ]

        const report = replayScenario(steps, ReplayPolicy.Simulate)

        expect(report.steps.every((replayed) => replayed.simulated)).toBe(true)
        expect(countReplayedEffects(report.port, ReplayEffect.Command)).toBe(1)
        expect(countReplayedEffects(report.port, ReplayEffect.McpTool)).toBe(1)
        expect(countReplayedEffects(report.port, ReplayEffect.Network)).toBe(1)
        expect(countReplayedEffects(report.port, ReplayEffect.FileWrite)).toBe(1)

        for (const spy of spies) {
            expect(spy).not.toHaveBeenCalled()
        }
    })

    it("refuses to replay an unclassified component", () => {
        // Fail closed: the port is never even asked, so a permissive port
        // cannot turn an unreviewed component into a performed effect.
        expect(() => replayScenario([step({ index: 0, component: "brand-new-domain" })], ReplayPolicy.Simulate)).toThrow(
            ReplayNotPermitted,
        )
    })

    it("never forwards free-form payloads to the port", () => {
        const report = replayScenario(
            [step({ index: 0, component: "terminal", operation: "execute", outcome: "failed" })],
            ReplayPolicy.Simulate,
        )

        const request = report.port.requests[0]
        expect(Object.keys(request).sort()).toEqual(["component", "effect", "operation", "recordedDurationMs", "recordedOutcome"])
    })

    it("reports the recorded outcome when the port replays it", () => {
        const report = replayScenario([step({ index: 0, component: "terminal", outcome: "failed" })], ReplayPolicy.Simulate)

        expect(report.steps[0].replayedOutcome).toBe("failed")
        expect(report.divergences).toEqual([])
    })

    it("fails loudly when replay is not permitted", () => {
        expect(() => replayScenario([step({ index: 0, component: "terminal" })], ReplayPolicy.Refuse)).toThrow(ReplayNotPermitted)
    })

    it("returns an empty report for an empty scenario", () => {
        const report = replayScenario([], ReplayPolicy.Simulate)

        expect(report.steps).toEqual([])
        expect(report.totalRecordedDurationMs).toBe(0)
        expect(report.port.requests).toHaveLength(0)
    })

    it("replays an inert step without asking for a real effect", () => {
        const report = replayScenario([step({ index: 0, component: "task_init", operation: "start" })], ReplayPolicy.Simulate)

        expect(report.steps).toHaveLength(1)
        expect(countReplayedEffects(report.port, ReplayEffect.Inert)).toBe(1)
    })
})

describe("resolveReplayPort", () => {
    it("hands out ports whose behaviour cannot be swapped out", () => {
        const port = resolveReplayPort(ReplayPolicy.Refuse)

        // A refusing port that can be reprogrammed through its prototype is not
        // a safety boundary, so both the instance and its prototype are frozen.
        expect(Object.isFrozen(port)).toBe(true)
        expect(Object.isFrozen(Object.getPrototypeOf(port))).toBe(true)
        expect(() => {
            ;(Object.getPrototypeOf(port) as { perform: unknown }).perform = () => "succeeded"
        }).toThrow(TypeError)
        expect(() => resolveReplayPort(ReplayPolicy.Refuse).perform({} as never)).toThrow(ReplayNotPermitted)
    })
})
