import { describe, expect, it } from "vitest"
import type { ImageGenerationEvent, ImageGenerationRequest, ImageProviderOutput } from "../contracts"
import { FakeImageGenerationAdapter } from "../testing/FakeImageGenerationAdapter"

const output: ImageProviderOutput = {
    id: "provider-output-1",
    source: { kind: "bytes", bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" },
    width: 1024,
    height: 1024,
}

function request(): ImageGenerationRequest {
    return {
        requestId: "request-1",
        profileId: "profile-1",
        providerId: "fake",
        modelId: "fake-image",
        operation: "generate",
        prompt: "A deterministic image",
        count: 1,
        references: [],
    }
}

async function collect(adapter: FakeImageGenerationAdapter, signal = new AbortController().signal) {
    const events: ImageGenerationEvent[] = []
    for await (const event of adapter.generate(request(), { signal })) events.push(event)
    return events
}

describe("FakeImageGenerationAdapter", () => {
    it("emits a deterministic successful lifecycle with optional preview", async () => {
        let now = 1000
        const adapter = new FakeImageGenerationAdapter({
            outputs: [output],
            previewOutputs: [output],
            now: () => now++,
        })

        const events = await collect(adapter)

        expect(events.map((event) => event.type)).toEqual(["queued", "started", "preview", "completed"])
        expect(events.map((event) => event.timestampMs)).toEqual([1000, 1001, 1002, 1003])
        expect(events.at(-1)).toMatchObject({ type: "completed", usage: { imageCount: 1, totalOutputBytes: 3 } })
    })

    it("emits a stable failed event instead of throwing provider failures", async () => {
        const adapter = new FakeImageGenerationAdapter({
            outputs: [],
            failure: { code: "content_filtered", message: "The prompt was rejected.", retryable: false },
            now: () => 7,
        })

        const events = await collect(adapter)

        expect(events.map((event) => event.type)).toEqual(["queued", "started", "failed"])
        expect(events.at(-1)).toMatchObject({
            type: "failed",
            error: { code: "content_filtered", retryable: false },
        })
    })

    it("emits cancelled without starting when the request is already aborted", async () => {
        const controller = new AbortController()
        controller.abort("task_cancelled")
        const adapter = new FakeImageGenerationAdapter({ outputs: [output], now: () => 9 })

        const events = await collect(adapter, controller.signal)

        expect(events.map((event) => event.type)).toEqual(["queued", "cancelled"])
        expect(events.at(-1)).toMatchObject({ type: "cancelled", reason: "task_cancelled" })
    })
})
