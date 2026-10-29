import { beforeEach, describe, expect, it, vi } from "vitest"
import { getImageArtifact } from "../getImageArtifact"

const { createTaskArtifactResolver, resolveImage } = vi.hoisted(() => ({
    createTaskArtifactResolver: vi.fn(),
    resolveImage: vi.fn(),
}))

vi.mock("@core/artifacts/runtime", () => ({ createTaskArtifactResolver }))

describe("getImageArtifact", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        createTaskArtifactResolver.mockReturnValue({ resolveImage })
        resolveImage.mockResolvedValue({
            artifact: { mimeType: "image/png" },
            bytes: new Uint8Array([1, 2, 3]),
        })
    })

    it("resolves the artifact only through the active task scope", async () => {
        const artifactId = `image:sha256:${"a".repeat(64)}`
        const result = await getImageArtifact({ task: { taskId: "task-1" } } as never, { artifactId })

        expect(createTaskArtifactResolver).toHaveBeenCalledWith("task-1")
        expect(resolveImage).toHaveBeenCalledWith(artifactId)
        expect(result).toEqual({ data: new Uint8Array([1, 2, 3]), mimeType: "image/png" })
    })

    it("rejects reads when there is no active task", async () => {
        await expect(
            getImageArtifact({ task: undefined } as never, { artifactId: `image:sha256:${"b".repeat(64)}` }),
        ).rejects.toThrow("An active task is required")
        expect(createTaskArtifactResolver).not.toHaveBeenCalled()
    })
})
