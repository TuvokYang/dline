import { describe, expect, it, vi } from "vitest"
import type { ProviderRequestReportPort } from "../../executors/provider/service/ProviderRequestReport"
import { InitialCheckpointRequestReporter } from "../InitialCheckpointRequestReporter"

function harness(options: { requested?: boolean; beginInitialCheckpoint?: () => Promise<void> } = {}) {
    const order: string[] = []
    let requested = options.requested ?? false
    const record = { settle: vi.fn(async () => undefined) }
    const inner: ProviderRequestReportPort = {
        begin: vi.fn(async () => {
            order.push("request")
            requested = true
            return record
        }),
    }
    const beginInitialCheckpoint =
        options.beginInitialCheckpoint ??
        vi.fn(async () => {
            order.push("baseline")
        })
    const reporter = new InitialCheckpointRequestReporter(inner, {
        checkpoints: { beginInitialCheckpoint },
        hasRequested: () => requested,
    })
    return { reporter, inner, record, order, beginInitialCheckpoint }
}

describe("InitialCheckpointRequestReporter", () => {
    it("opens the baseline before the first request opens its own row", async () => {
        const { reporter, record, order } = harness()

        await expect(reporter.begin({ turnId: "turn-1" })).resolves.toBe(record)

        expect(order).toEqual(["baseline", "request"])
    })

    it("leaves later requests alone", async () => {
        const { reporter, order, beginInitialCheckpoint } = harness()

        await reporter.begin({ turnId: "turn-1" })
        await reporter.begin({ turnId: "turn-2" })

        expect(beginInitialCheckpoint).toHaveBeenCalledOnce()
        expect(order).toEqual(["baseline", "request", "request"])
    })

    it("does not open a baseline for a task that already sent a request", async () => {
        const { reporter, beginInitialCheckpoint } = harness({ requested: true })

        await reporter.begin({ turnId: "turn-9" })

        expect(beginInitialCheckpoint).not.toHaveBeenCalled()
    })

    it("still sends the request when the baseline cannot be opened", async () => {
        const { reporter, inner } = harness({
            beginInitialCheckpoint: vi.fn(async () => {
                throw new Error("shadow repository unavailable")
            }),
        })

        await reporter.begin({ turnId: "turn-1" })

        expect(inner.begin).toHaveBeenCalledOnce()
    })
})
