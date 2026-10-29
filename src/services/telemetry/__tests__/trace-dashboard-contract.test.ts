import { readFile } from "node:fs/promises"
import path from "node:path"
import { describe, expect, it } from "vitest"

interface DashboardPanel {
    readonly title?: string
    readonly targets?: readonly { readonly expr?: string }[]
}

interface Dashboard {
    readonly version?: number
    readonly panels?: readonly DashboardPanel[]
}

async function dashboard(name: string): Promise<Dashboard> {
    return JSON.parse(await readFile(path.join(__dirname, "..", "..", "..", "..", "scripts", "otel", name), "utf8"))
}

describe("OTel trace dashboard contract", () => {
    it("shows production tool and MCP failures and includes them in the trace timeline", async () => {
        const errors = await dashboard("dline-errors-dashboard.json")
        const failureLogs = errors.panels?.find((panel) => panel.title === "Recent Tool / MCP Failure Logs")
        const timeline = errors.panels?.find((panel) => panel.title === "Task / API Timeline for traceFilter")

        expect(errors.version).toBeGreaterThanOrEqual(2)
        expect(failureLogs?.targets?.[0]?.expr).toContain("tool\\.execution\\.failed")
        expect(failureLogs?.targets?.[0]?.expr).toContain("mcp\\.tools\\.call\\.failed")
        expect(timeline?.targets?.[0]?.expr).toContain("tool\\.execution")
        expect(timeline?.targets?.[0]?.expr).toContain("mcp\\.tools\\.call")
    })

    it("keeps the tool duration panel aligned with the production histogram label", async () => {
        const performance = await dashboard("dline-performance-dashboard.json")
        const panel = performance.panels?.find((candidate) => candidate.title === "Tool Active Duration p95 by Tool")

        expect(panel?.targets?.[0]?.expr).toContain('operation="tool.execution"')
        expect(panel?.targets?.[0]?.expr).toContain("sum by (le, tool)")
    })
})
