import { describe, expect, it, vi } from "vitest"
import { resolveToolCallSideEffects } from "../ToolCallSideEffects"
import type { TaskConfig } from "../types/TaskConfig"

describe("tool call checkpoint ownership", () => {
    it("exposes only tool progress reporting", () => {
        const config = {
            callbacks: {
                updateFCListFromToolResponse: vi.fn(async () => undefined),
            },
        } as unknown as TaskConfig

        const effects = resolveToolCallSideEffects(config)

        expect(effects).toEqual({ reportProgress: expect.any(Function) })
    })
})
