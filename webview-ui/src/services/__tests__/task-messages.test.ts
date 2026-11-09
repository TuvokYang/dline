import { FetchMessageRequest, FetchMessageResponse } from "@shared/proto/dline/task"
import { beforeEach, describe, expect, it, vi } from "vitest"

const fetchMessage = vi.hoisted(() => vi.fn())
vi.mock("../grpc-client", () => ({ TaskServiceClient: { fetchMessage } }))

import { fetchAnchoredTaskMessages, fetchTaskMessages } from "../task-messages"

const OPENING = { taskId: "task", taskInstanceId: "opening" }

describe("task message page transport", () => {
    beforeEach(() => {
        fetchMessage.mockReset()
        fetchMessage.mockResolvedValue(FetchMessageResponse.create({ ...OPENING, startIndex: 230, anchorFound: true }))
    })

    it.each([
        0, 67,
    ])("passes source index %s and timestamp identity through the request builder and codec", async (anchorIndex) => {
        const response = await fetchAnchoredTaskMessages(OPENING, 90, 40, anchorIndex)
        const request = fetchMessage.mock.calls[0][0] as FetchMessageRequest
        const decoded = FetchMessageRequest.decode(FetchMessageRequest.encode(request).finish())
        expect(decoded).toMatchObject({ ...OPENING, anchorIndex, anchorTs: 90, referenceIndex: 0, count: 40 })
        // The response's page coordinate is not the requested committed ordinal.
        expect(response.startIndex).toBe(230)
        expect(response.anchorFound).toBe(true)
    })

    it("retains index-only navigation without inventing a timestamp", async () => {
        await fetchAnchoredTaskMessages(OPENING, undefined, 30, 0)
        const request = fetchMessage.mock.calls[0][0] as FetchMessageRequest
        const decoded = FetchMessageRequest.decode(FetchMessageRequest.encode(request).finish())
        expect(decoded.anchorIndex).toBe(0)
        expect(decoded.anchorTs).toBeUndefined()
    })

    it("keeps legacy timestamp-only and ordinary page requests free of fabricated source indices", async () => {
        await fetchAnchoredTaskMessages(OPENING, 0, 25)
        await fetchTaskMessages(OPENING, -1, 100)
        const requests = fetchMessage.mock.calls.map(([request]) =>
            FetchMessageRequest.decode(FetchMessageRequest.encode(request).finish()),
        )
        const targets = requests.map(({ referenceIndex, count, anchorTs, anchorIndex }) => ({
            referenceIndex,
            count,
            anchorTs,
            anchorIndex,
        }))
        expect(targets).toEqual([
            { referenceIndex: 0, count: 25, anchorTs: 0, anchorIndex: undefined },
            { referenceIndex: -1, count: 100, anchorTs: undefined, anchorIndex: undefined },
        ])
    })

    it("reports a rejected request without caching its failure or disabling the next click", async () => {
        fetchMessage.mockRejectedValueOnce(new Error("read failed"))
        await expect(fetchAnchoredTaskMessages(OPENING, 9, 30, 4)).rejects.toThrow("read failed")
        await expect(fetchAnchoredTaskMessages(OPENING, 8, 30, 5)).resolves.toMatchObject({ startIndex: 230 })
        expect(fetchMessage.mock.calls.map(([request]) => request.anchorIndex)).toEqual([4, 5])
    })

    it("retains opening ownership checks before and after I/O", async () => {
        await expect(fetchAnchoredTaskMessages(undefined, 9, 30, 0)).rejects.toThrow("No opened Task instance")
        expect(fetchMessage).not.toHaveBeenCalled()
        fetchMessage.mockResolvedValueOnce(FetchMessageResponse.create({ ...OPENING, taskInstanceId: "previous" }))
        await expect(fetchAnchoredTaskMessages(OPENING, 9, 30, 0)).rejects.toThrow("different Task opening")
    })
})
