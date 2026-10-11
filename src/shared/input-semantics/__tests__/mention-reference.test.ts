import { describe, expect, it } from "vitest"
import { BUILTIN_INPUT_SEMANTICS } from "../catalog"
import { isMentionNode } from "../document"
import { lexSemanticInput } from "../lexer"
import { formatMentionReference, parseMentionReference } from "../mention-reference"

/** What the scanner reads back for `@<spelling>`. */
function readBack(spelling: string) {
    const [node] = lexSemanticInput(`@${spelling}`, {
        catalog: { revision: 1, descriptors: BUILTIN_INPUT_SEMANTICS },
        documentId: "test",
    }).nodes.filter(isMentionNode)
    return node && { sourceText: node.sourceText, kind: node.mentionKind, ref: node.canonicalRef, hint: node.workspaceHint }
}

describe("parseMentionReference", () => {
    it("classifies self-contained references, commits and URLs", () => {
        expect(parseMentionReference("problems")).toEqual({ kind: "problems", ref: "problems" })
        expect(parseMentionReference("terminal")).toEqual({ kind: "terminal", ref: "terminal" })
        expect(parseMentionReference("git-changes")).toEqual({ kind: "git_changes", ref: "git-changes" })
        expect(parseMentionReference("abc1234")).toEqual({ kind: "git_commit", ref: "abc1234" })
        expect(parseMentionReference("https://x.dev/a")).toEqual({ kind: "url", ref: "https://x.dev/a" })
    })

    it("reads quotes as delimiters, never as part of the path or its kind", () => {
        expect(parseMentionReference('"/a b/"')).toEqual({ kind: "folder", ref: "/a b/" })
        expect(parseMentionReference('"/a b.ts"')).toEqual({ kind: "file", ref: "/a b.ts" })
        expect(parseMentionReference("/src/")).toEqual({ kind: "folder", ref: "/src/" })
    })

    it("separates a workspace prefix from its path, quoted or not", () => {
        expect(parseMentionReference("web:/src/a.ts")).toEqual({ kind: "file", ref: "/src/a.ts", workspaceHint: "web" })
        expect(parseMentionReference('web:"/my dir/"')).toEqual({ kind: "folder", ref: "/my dir/", workspaceHint: "web" })
    })
})

describe("formatMentionReference", () => {
    it("quotes only paths that would otherwise end early", () => {
        expect(formatMentionReference("/src/a.ts")).toBe("/src/a.ts")
        expect(formatMentionReference("/src/my file.ts")).toBe('"/src/my file.ts"')
        expect(formatMentionReference("/notes/v1.")).toBe('"/notes/v1."')
        expect(formatMentionReference("web:/my file.ts")).toBe('web:"/my file.ts"')
        expect(formatMentionReference("problems")).toBe("problems")
        expect(formatMentionReference("https://x.dev/a b")).toBe("https://x.dev/a b")
    })

    it("round-trips through the scanner as the same entity", () => {
        for (const reference of ["/src/a.ts", "/my dir/", "/src/my file.ts", "/notes/v1.", "web:/src/a.ts", "web:/my dir/"]) {
            const spelling = formatMentionReference(reference)
            const parsed = parseMentionReference(reference)

            expect(readBack(spelling)).toEqual({
                sourceText: `@${spelling}`,
                kind: parsed.kind,
                ref: parsed.ref,
                hint: parsed.workspaceHint,
            })
        }
    })
})
