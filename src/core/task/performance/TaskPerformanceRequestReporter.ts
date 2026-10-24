import type { ProviderRequestRecord, ProviderRequestReportPort } from "../executors/provider/service/ProviderRequestReport"
import type { TaskPerformanceOwner } from "./TaskPerformanceOwner"

/** Adds task-rate accounting around the user-visible provider request record. */
export class TaskPerformanceRequestReporter implements ProviderRequestReportPort {
    constructor(
        private readonly report: ProviderRequestReportPort,
        private readonly performance: TaskPerformanceOwner,
    ) {}

    async begin(input: { readonly turnId: string }): Promise<ProviderRequestRecord> {
        this.performance.requestStarted()
        let record: ProviderRequestRecord
        try {
            record = await this.report.begin(input)
        } catch (error) {
            this.performance.requestSettled()
            throw error
        }
        return {
            ...record,
            settle: async (settlement) => {
                this.performance.requestSettled(settlement.usage)
                await record.settle(settlement)
            },
        }
    }
}
