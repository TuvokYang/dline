import { render, waitFor } from "@testing-library/react"
import { useLayoutEffect, useRef } from "react"
import { describe, expect, it } from "vitest"
import CodeBlock from "../CodeBlock"

function CommitProbe({ source, onCommit }: { source: string; onCommit: (text: string) => void }) {
    const root = useRef<HTMLDivElement>(null)
    useLayoutEffect(() => {
        onCommit(root.current?.textContent ?? "")
    }, [source, onCommit])
    return (
        <div ref={root}>
            <CodeBlock source={source} />
        </div>
    )
}

const fenced = (text: string, language = "shell") => `\`\`\`${language}\n${text}\n\`\`\``

describe("CodeBlock committed content", () => {
    it("has every output line before the first layout measurement", () => {
        const output = Array.from({ length: 40 }, (_, index) => `result line ${index + 1}`).join("\n")
        const commits: string[] = []
        render(<CommitProbe onCommit={(text) => commits.push(text)} source={fenced(output)} />)
        expect(commits[0]).toBe(`${output}\n`)
    })

    it("does not reintroduce an empty body when a virtual row remounts", async () => {
        const output = "echo restored history"
        const first = render(<CodeBlock source={fenced(output)} />)
        await waitFor(() => expect(first.container.querySelector("code")?.textContent).toBe(`${output}\n`))
        first.unmount()
        const commits: string[] = []
        render(<CommitProbe onCommit={(text) => commits.push(text)} source={fenced(output)} />)
        expect(commits[0]).toBe(`${output}\n`)
    })

    it("commits the current stream chunk instead of the previous chunk", async () => {
        const commits: string[] = []
        const onCommit = (text: string) => commits.push(text)
        const view = render(<CommitProbe onCommit={onCommit} source={fenced("first")} />)
        await waitFor(() => expect(view.container.querySelector("code")?.textContent).toBe("first\n"))
        commits.length = 0
        view.rerender(<CommitProbe onCommit={onCommit} source={fenced("first\nsecond")} />)
        expect(commits[0]).toBe("first\nsecond\n")
    })

    it.each(["", "example.ts"])("preserves highlighting and code text for language %s", async (language) => {
        const code = 'const value = "<script>alert(1)</script>"'
        const view = render(<CodeBlock source={fenced(code, language)} />)
        await waitFor(() => expect(view.container.querySelector("pre > code")?.textContent).toBe(`${code}\n`))
        expect(view.container.querySelector("code .hljs-keyword")?.textContent).toBe("const")
        expect(view.container.querySelector("script")).toBeNull()
    })

    it("clears the previous body in the same commit when the source becomes empty", async () => {
        const commits: string[] = []
        const onCommit = (text: string) => commits.push(text)
        const view = render(<CommitProbe onCommit={onCommit} source={fenced("old output")} />)
        await waitFor(() => expect(view.container.querySelector("code")?.textContent).toBe("old output\n"))
        commits.length = 0
        view.rerender(<CommitProbe onCommit={onCommit} source="" />)
        expect(commits[0]).toBe("")
    })
})
