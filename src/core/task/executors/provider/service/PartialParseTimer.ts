import { recordPerfPhase } from "@/services/telemetry/instrumentation/duration-recorder"
import { PerfDomain } from "@/services/telemetry/instrumentation/perf-domains"

/** How the reply carries its tool calls while it streams. */
export type PartialParseFormat = "native" | "xml"

/**
 * Sums the synchronous work one streamed reply spends re-reading its partial
 * tool calls.
 *
 * Every delta re-parses the call or markup it extends, so the cost grows with
 * the reply rather than with the delta. A span per delta would emit thousands of
 * samples per reply; one total per format and reply keeps the series bounded
 * while still showing whether streaming parse can account for a stalled loop.
 * The recorded value is a sum of disjoint slices, not one contiguous interval.
 */
export class PartialParseTimer {
    private readonly totals: Record<PartialParseFormat, number> = { native: 0, xml: 0 }
    private flushed = false

    /** Run one synchronous parse step and add its duration to the format's total. */
    time<T>(format: PartialParseFormat, parse: () => T): T {
        const startedAt = performance.now()
        try {
            return parse()
        } finally {
            this.totals[format] += performance.now() - startedAt
        }
    }

    /** Emit each format that did any work. Later calls are ignored so every exit path may call it. */
    flush(): void {
        if (this.flushed) return
        this.flushed = true
        for (const format of ["native", "xml"] as const) {
            const durationMs = this.totals[format]
            if (durationMs > 0) recordPerfPhase(PerfDomain.TurnPrepare, "partial_tool_parse", durationMs, { format })
        }
    }
}
