import { describe, expect, it } from "vitest"
import { parseFragment, serializeFragment } from "../clipboard"
import type { ComposerSegment, ResourceAtom } from "../model"

const COMPOSER = "draft-a"

const compact: ComposerSegment = {
    kind: "atom",
    atom: {
        kind: "command",
        entityId: "cmd-1",
        commandId: "command.compact",
        sourceText: "/compact",
        canonicalName: "compact",
        namespace: "cmd",
        compositionMode: "lifecycle_barrier",
    },
}

const mention: ComposerSegment = {
    kind: "atom",
    atom: {
        kind: "mention",
        entityId: "men-1",
        mentionKind: "file",
        sourceText: "@/src/a.ts",
        canonicalRef: "/src/a.ts",
        capturePolicy: "snapshot_at_submit",
    },
}

function resource(status: ResourceAtom["status"], entityId = "res-1"): ComposerSegment {
    return {
        kind: "atom",
        atom: {
            kind: "resource",
            entityId,
            nodeKind: "image",
            fileOrigin: "pasted_file",
            displayName: "shot.png",
            status,
            previewUrl: "blob:vscode-webview://preview",
            ...(status === "ready"
                ? {
                      ref: {
                          resourceId: "r-1",
                          expectedContentHash: "sha256:abc",
                          mediaType: "image/png",
                          byteLength: 3,
                          owner: { kind: "draft", draftId: COMPOSER },
                          generation: 1,
                      },
                  }
                : {}),
        },
    }
}

/** A serialized fragment with one part replaced, as untrusted clipboard data might carry it. */
function tampered(segments: readonly unknown[]): string {
    return JSON.stringify({ version: 1, composerId: COMPOSER, segments })
}

describe("parseFragment", () => {
    it("restores this composer's fragment with fresh atom identities and no shared preview URL", () => {
        const raw = serializeFragment(
            [{ kind: "text", text: "run ", source: "typed" }, compact, mention, resource("ready")],
            COMPOSER,
        )

        const parsed = parseFragment(raw, COMPOSER)

        expect(parsed?.map((segment) => (segment.kind === "text" ? segment.source : segment.atom.kind))).toEqual([
            "typed",
            "command",
            "mention",
            "resource",
        ])
        const atoms = parsed?.flatMap((segment) => (segment.kind === "atom" ? [segment.atom] : [])) ?? []
        expect(atoms.map((atom) => atom.entityId)).not.toContain("cmd-1")
        expect(new Set(atoms.map((atom) => atom.entityId)).size).toBe(3)
        expect(atoms.find((atom) => atom.kind === "resource")).not.toHaveProperty("previewUrl")
    })

    it("refuses another draft's fragment so its text is pasted as foreign text instead", () => {
        const raw = serializeFragment([{ kind: "text", text: "/compact", source: "typed" }, compact], "draft-b")

        expect(parseFragment(raw, COMPOSER)).toBeUndefined()
    })

    it.each([
        ["text with an unknown source", { kind: "text", text: "x", source: "trusted" }],
        ["text that is not a string", { kind: "text", text: 1, source: "typed" }],
        ["a command in an unknown namespace", { kind: "atom", atom: { ...compact.atom, namespace: "root" } }],
        ["a command without its identity", { kind: "atom", atom: { ...compact.atom, commandId: undefined } }],
        ["a mention of an unknown kind", { kind: "atom", atom: { ...mention.atom, mentionKind: "secret" } }],
        ["a mention with an unknown capture policy", { kind: "atom", atom: { ...mention.atom, capturePolicy: "never" } }],
        ["an atom of an unknown kind", { kind: "atom", atom: { kind: "macro", entityId: "m" } }],
    ])("refuses the whole fragment when it holds %s", (_label, invalid) => {
        expect(parseFragment(tampered([{ kind: "text", text: "a", source: "typed" }, invalid]), COMPOSER)).toBeUndefined()
    })

    it("leaves staging, failed and malformed resource chips out of the copy and keeps the rest", () => {
        const malformed = { kind: "atom", atom: { ...resource("ready").atom, ref: { resourceId: "r-1" } } }
        const raw = tampered([
            { kind: "text", text: "a", source: "typed" },
            resource("staging", "res-s"),
            resource("failed", "res-f"),
            malformed,
            { kind: "text", text: "b", source: "typed" },
        ])

        expect(parseFragment(raw, COMPOSER)).toEqual([{ kind: "text", text: "ab", source: "typed" }])
    })

    it("rebuilds a pasted resource reference field by field and drops foreign properties", () => {
        const ready = resource("ready").atom as ResourceAtom & { ref: Record<string, unknown> }
        const raw = tampered([
            {
                kind: "atom",
                atom: {
                    ...ready,
                    ref: { ...ready.ref, path: "/etc/passwd", owner: { ...(ready.ref.owner as object), extra: true } },
                },
            },
        ])

        const parsed = parseFragment(raw, COMPOSER)
        const atom = parsed?.[0]?.kind === "atom" ? parsed[0].atom : undefined

        expect(atom?.kind === "resource" ? atom.ref : undefined).toEqual({
            resourceId: "r-1",
            expectedContentHash: "sha256:abc",
            mediaType: "image/png",
            byteLength: 3,
            owner: { kind: "draft", draftId: COMPOSER },
            generation: 1,
        })
    })

    it.each([
        ["an owner of an unknown kind", { owner: { kind: "workspace", draftId: COMPOSER } }],
        ["a draft owner without its id", { owner: { kind: "draft", draftId: "" } }],
        ["a task owner without its id", { owner: { kind: "task" } }],
        ["an empty resource id", { resourceId: "" }],
        ["an empty content hash", { expectedContentHash: "" }],
        ["an empty media type", { mediaType: "" }],
        ["a fractional byte length", { byteLength: 1.5 }],
        ["generation zero", { generation: 0 }],
    ])("omits a resource chip whose reference has %s", (_label, override) => {
        const ready = resource("ready").atom as ResourceAtom & { ref: Record<string, unknown> }
        const raw = tampered([
            { kind: "text", text: "a", source: "typed" },
            { kind: "atom", atom: { ...ready, ref: { ...ready.ref, ...override } } },
        ])

        expect(parseFragment(raw, COMPOSER)).toEqual([{ kind: "text", text: "a", source: "typed" }])
    })

    it("keeps a task-owned reference, as a restored queued draft carries one", () => {
        const ready = resource("ready").atom as ResourceAtom & { ref: Record<string, unknown> }
        const raw = tampered([
            { kind: "atom", atom: { ...ready, ref: { ...ready.ref, owner: { kind: "task", taskId: "t-1" } } } },
        ])

        const parsed = parseFragment(raw, COMPOSER)
        const atom = parsed?.[0]?.kind === "atom" ? parsed[0].atom : undefined

        expect(atom?.kind === "resource" ? atom.ref?.owner : undefined).toEqual({ kind: "task", taskId: "t-1" })
    })

    it.each([
        ["not JSON", "{"],
        ["an unknown version", JSON.stringify({ version: 2, composerId: COMPOSER, segments: [] })],
        ["segments that are not a list", JSON.stringify({ version: 1, composerId: COMPOSER, segments: {} })],
        ["no data", ""],
    ])("returns undefined for %s", (_label, raw) => {
        expect(parseFragment(raw, COMPOSER)).toBeUndefined()
    })
})
