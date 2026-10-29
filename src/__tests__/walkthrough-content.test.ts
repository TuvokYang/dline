import fs from "node:fs/promises"
import path from "node:path"
import { describe, expect, it } from "vitest"

interface WalkthroughStep {
    id: string
    title: string
    description: string
    media: { markdown: string }
}

interface ExtensionManifest {
    contributes?: {
        commands?: Array<{ command: string }>
        walkthroughs?: Array<{ id: string; steps: WalkthroughStep[] }>
    }
}

const PROJECT_ROOT = process.cwd()
const HTTPS_URL = /https:\/\/[^\s)]+/g
const COMMAND_URL = /command:([\w.-]+)/g

async function readManifest(): Promise<ExtensionManifest> {
    return JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, "package.json"), "utf8"))
}

describe("Dline walkthrough content", () => {
    it("keeps every manifest step aligned with a packaged Dline-owned Markdown page", async () => {
        const manifest = await readManifest()
        const walkthroughs = manifest.contributes?.walkthroughs ?? []
        const steps = walkthroughs.flatMap((walkthrough) => walkthrough.steps)

        expect(walkthroughs).toHaveLength(1)
        expect(steps).toHaveLength(5)
        expect(new Set(steps.map((step) => step.id)).size).toBe(steps.length)

        for (const step of steps) {
            expect(step.media.markdown).toMatch(/^walkthrough\/[^/]+\.md$/)
            const markdown = await fs.readFile(path.join(PROJECT_ROOT, step.media.markdown), "utf8")

            expect(markdown.split("\n", 1)[0]).toBe(`# ${step.title}`)
            expect(markdown).not.toMatch(/\bCline\b|cline_public_images|storage\.googleapis\.com/i)

            for (const url of markdown.match(HTTPS_URL) ?? []) {
                const hostname = new URL(url).hostname
                expect(hostname === "dline.cc" || hostname.endsWith(".dline.cc"), `${url} must use the Dline domain`).toBe(true)
            }
        }
    })

    it("links walkthrough actions only to commands declared by the extension", async () => {
        const manifest = await readManifest()
        const declaredCommands = new Set((manifest.contributes?.commands ?? []).map(({ command }) => command))
        const steps = (manifest.contributes?.walkthroughs ?? []).flatMap((walkthrough) => walkthrough.steps)
        const linkedCommands: string[] = []

        for (const step of steps) {
            const markdown = await fs.readFile(path.join(PROJECT_ROOT, step.media.markdown), "utf8")
            linkedCommands.push(...[...markdown.matchAll(COMMAND_URL)].map((match) => match[1]))
        }

        expect(linkedCommands.length).toBeGreaterThan(0)
        for (const command of linkedCommands) {
            expect(declaredCommands.has(command), `${command} must be declared in package.json`).toBe(true)
        }
    })
})
