import { ModelInfo as ProtoModelInfo } from "@shared/proto/dline/models"
import { describe, expect, it } from "vitest"
import { resolveInputMediaTypes } from "../input-media"

describe("resolveInputMediaTypes", () => {
    it("uses the media types the model declares, normalized", () => {
        const types = resolveInputMediaTypes({ capabilities: { inputMediaTypes: ["Image/PNG", "application/pdf; v=1"] } })

        expect([...types]).toEqual(["image/png", "application/pdf"])
    })

    // Protobuf cannot carry an empty repeated field, so an empty list must mean
    // the same as a missing one or the answer would depend on the transport.
    it("treats an empty declaration as undeclared", () => {
        const empty = resolveInputMediaTypes({ capabilities: { supportsImages: true, inputMediaTypes: [] } })

        expect(empty).toEqual(resolveInputMediaTypes({ capabilities: { supportsImages: true } }))
    })

    it("resolves the same declaration after a protobuf binary round trip", () => {
        for (const inputMediaTypes of [["image/png"], []]) {
            const info = ProtoModelInfo.fromPartial({ id: "m", capabilities: { supportsImages: true, inputMediaTypes } })
            const decoded = ProtoModelInfo.decode(ProtoModelInfo.encode(info).finish())

            expect(resolveInputMediaTypes(decoded)).toEqual(resolveInputMediaTypes(info))
        }
    })

    it("ignores malformed declarations from unchecked catalog JSON", () => {
        const malformed = (value: unknown) =>
            resolveInputMediaTypes({ capabilities: { supportsImages: false, inputMediaTypes: value as string[] } })

        expect(malformed(null).size).toBe(0)
        expect(malformed("application/pdf").size).toBe(0)
        expect([...malformed([42, "application/pdf", ""])]).toEqual(["application/pdf"])
    })

    it("derives the legacy set from supportsImages when nothing is declared", () => {
        const vision = resolveInputMediaTypes({ capabilities: { supportsImages: true } })

        expect(vision.has("image/png")).toBe(true)
        expect(vision.has("application/pdf")).toBe(true)
        expect(resolveInputMediaTypes({ capabilities: { supportsImages: false } }).size).toBe(0)
        expect(resolveInputMediaTypes(undefined).size).toBe(0)
    })
})
