import { afterEach, describe, expect, it, vi } from "vitest"
import { TaskAutoRetryController } from "./TaskAutoRetryController"

afterEach(() => {
    vi.useRealTimers()
})

function createController(options: { aborted?: boolean } = {}) {
    let aborted = options.aborted ?? false
    const publishState = vi.fn(async () => undefined)
    const reportPublishError = vi.fn()
    const controller = new TaskAutoRetryController({
        isAborted: () => aborted,
        publishState,
        reportPublishError,
    })
    return { controller, publishState, reportPublishError, setAborted: (value: boolean) => (aborted = value) }
}

describe("TaskAutoRetryController", () => {
    it("publishes a pending retry and settles it when the timer expires", async () => {
        vi.useFakeTimers()
        const { controller, publishState } = createController()

        const allowed = controller.wait(100)
        expect(controller.hasPending()).toBe(true)
        expect(controller.hasSequence()).toBe(true)
        expect(publishState).toHaveBeenCalledOnce()

        await vi.advanceTimersByTimeAsync(100)
        await expect(allowed).resolves.toBe(true)
        expect(controller.hasPending()).toBe(false)
        expect(controller.hasSequence()).toBe(true)
        expect(publishState).toHaveBeenCalledTimes(2)
    })

    it("cancels the complete sequence and resolves the pending wait as disallowed", async () => {
        vi.useFakeTimers()
        const { controller } = createController()
        const allowed = controller.wait(100)

        controller.cancelPending()

        await expect(allowed).resolves.toBe(false)
        expect(controller.hasPending()).toBe(false)
        expect(controller.hasSequence()).toBe(false)
    })

    it("transfers a pending sequence to manual control exactly once", async () => {
        vi.useFakeTimers()
        const { controller } = createController()
        const allowed = controller.wait(100)

        expect(controller.overridePending()).toBe(true)
        await expect(allowed).resolves.toBe(true)
        expect(controller.hasSequence()).toBe(false)
        expect(controller.hasManualTakeover()).toBe(true)
        expect(controller.consumeManualTakeover()).toBe(true)
        expect(controller.consumeManualTakeover()).toBe(false)
    })

    it("does not expose pending or sequence state after task abort", () => {
        vi.useFakeTimers()
        const { controller, setAborted } = createController()
        void controller.wait(100)

        setAborted(true)

        expect(controller.hasPending()).toBe(false)
        expect(controller.hasSequence()).toBe(false)
        expect(controller.overridePending()).toBe(false)
    })
})
