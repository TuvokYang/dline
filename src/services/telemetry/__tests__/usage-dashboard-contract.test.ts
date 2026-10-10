import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

interface DashboardTarget {
    readonly datasource?: { readonly type?: string }
    readonly expr?: string
}

interface DashboardPanel {
    readonly title?: string
    readonly type?: string
    readonly datasource?: { readonly type?: string }
    readonly gridPos?: { readonly x?: number; readonly y?: number; readonly w?: number; readonly h?: number }
    readonly targets?: readonly DashboardTarget[]
}

interface UsageDashboard {
    readonly version?: number
    readonly panels?: readonly DashboardPanel[]
}

const dashboard = JSON.parse(
    readFileSync(path.resolve(process.cwd(), "scripts/otel/dline-usage-dashboard.json"), "utf8"),
) as UsageDashboard

function panel(title: string): DashboardPanel {
    const found = dashboard.panels?.find((candidate) => candidate.title === title)
    if (!found) throw new Error(`Missing dashboard panel: ${title}`)
    return found
}

describe("Dline OTel usage dashboard contract", () => {
    it("includes user, provider/model share, reasoning, and hosted-tool panels", () => {
        expect(dashboard.version).toBeGreaterThanOrEqual(3)
        expect(panel("Active Users").type).toBe("stat")
        expect(panel("Token Share by Model").type).toBe("piechart")
        expect(panel("Token Share by Provider").type).toBe("piechart")
        expect(panel("Request Share by Provider").type).toBe("piechart")
        expect(panel("Reasoning Tokens").type).toBe("stat")
        expect(panel("Hosted Tool Requests").type).toBe("stat")
    })

    it("counts users from Loki distinct_id metadata without exposing identifiers", () => {
        const activeUsers = panel("Active Users")
        const query = activeUsers.targets?.[0]?.expr ?? ""

        expect(activeUsers.datasource?.type).toBe("loki")
        expect(query).toContain("count(sum by (distinct_id)")
        expect(query).toContain('count_over_time({service_name="dline"} |= "task.tokens"')
        expect(query).toContain("[$__range]")
        expect(query).toContain('provider=~"$provider"')
        expect(query).toContain('model=~"$model"')
        expect(query).toContain('apiFormatName=~"$apiFormat"')
    })

    it("queries the dedicated reasoning and hosted-tool usage metrics", () => {
        expect(panel("Reasoning Tokens").targets?.[0]?.expr).toContain("dline_tokens_thoughts_total")
        expect(panel("Hosted Tool Requests").targets?.[0]?.expr).toContain("dline_server_tool_requests_total")
        expect(panel("Hosted Tool Requests").targets?.[0]?.expr).toContain("sum by (server_tool)")
    })

    it("keeps Prometheus usage filters on the emitted apiFormat label", () => {
        const queries = (dashboard.panels ?? [])
            .flatMap((candidate) => candidate.targets ?? [])
            .filter((target) => target.datasource?.type === "prometheus")
            .map((target) => target.expr ?? "")
            .filter((query) => query.includes("dline_") && query.includes("apiFormat"))

        expect(queries.length).toBeGreaterThan(0)
        for (const query of queries) {
            expect(query).toContain('apiFormat=~"$apiFormat"')
            expect(query).not.toContain('api_format=~"$apiFormat"')
        }
    })

    it("lays out the summary row without overlaps", () => {
        const summary = (dashboard.panels ?? []).filter((candidate) => candidate.gridPos?.y === 0)
        const occupied = new Set<number>()
        for (const candidate of summary) {
            const x = candidate.gridPos?.x ?? 0
            const width = candidate.gridPos?.w ?? 0
            for (let column = x; column < x + width; column++) {
                expect(occupied.has(column), `${candidate.title} overlaps column ${column}`).toBe(false)
                occupied.add(column)
            }
        }
        expect([...occupied].sort((left, right) => left - right)).toEqual([...Array(24).keys()])
    })
})
