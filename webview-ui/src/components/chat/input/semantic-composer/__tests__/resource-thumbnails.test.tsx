import type { SemanticResourceRef } from "@shared/input-semantics/document"
import { renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetResourceThumbnailsForTesting, useResourceThumbnail } from "../resource-thumbnails"

const { readInputResourceImage } = vi.hoisted(() => ({
    readInputResourceImage: vi.fn(async () => ({ data: new Uint8Array([1, 2, 3]), mimeType: "image/png" })),
}))

vi.mock("@/services/grpc-client", () => ({ FileServiceClient: { readInputResourceImage } }))

/** A fresh reference object to the same image bytes, as a rebuilt message row produces. */
function imageRef(): SemanticResourceRef {
    return {
        resourceId: "r-image",
        expectedContentHash: "sha256:image",
        mediaType: "image/png",
        byteLength: 3,
        owner: { kind: "draft", draftId: "draft-1" },
        generation: 1,
    }
}

describe("useResourceThumbnail", () => {
    beforeEach(() => {
        resetResourceThumbnailsForTesting()
        readInputResourceImage.mockClear()
        URL.createObjectURL = vi.fn(() => "blob:thumbnail")
    })

    afterEach(() => {
        resetResourceThumbnailsForTesting()
    })

    // A row rebuilds its references on every update. Reloading per object
    // flipped the chip between icon and image, which re-measured the row in the
    // virtualized list and shook a long conversation at the bottom.
    it("keeps the thumbnail when the reference is rebuilt for the same bytes", async () => {
        const seen: Array<string | undefined> = []
        const { rerender } = renderHook(
            ({ ref }) => {
                const url = useResourceThumbnail(ref)
                seen.push(url)
                return url
            },
            { initialProps: { ref: imageRef() } },
        )
        await waitFor(() => expect(seen.at(-1)).toBe("blob:thumbnail"))
        const loadedAt = seen.length

        rerender({ ref: imageRef() })
        rerender({ ref: imageRef() })

        expect(seen.slice(loadedAt)).toEqual(["blob:thumbnail", "blob:thumbnail"])
        expect(readInputResourceImage).toHaveBeenCalledOnce()
    })

    it("draws an already loaded thumbnail on the first render of a remounted chip", async () => {
        const first = renderHook(() => useResourceThumbnail(imageRef()))
        await waitFor(() => expect(first.result.current).toBe("blob:thumbnail"))
        first.unmount()

        const seen: Array<string | undefined> = []
        renderHook(() => {
            const url = useResourceThumbnail(imageRef())
            seen.push(url)
            return url
        })

        expect(seen[0]).toBe("blob:thumbnail")
        expect(readInputResourceImage).toHaveBeenCalledOnce()
    })
})
