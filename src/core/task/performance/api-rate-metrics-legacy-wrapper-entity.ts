import { column, defineEntity } from "@core/storage/backend/api/EntitySchema"
import { type ApiRateMetricsStoredRecord, isApiRateMetricsStoredRecord } from "./api-rate-metrics-record-codec"

export class LegacyApiRateMetricsWrapperEntity {
    static readonly storage = defineEntity<LegacyApiRateMetricsWrapperEntity>()({
        schemaId: "api-rate-metrics",
        version: 1,
        columns: {
            partition: column.text({ primary: true }),
            logicalKey: column.text({ primary: true }),
            sortKey: column.integer({ indexed: true }),
            revision: column.integer({ primary: true }),
            record: column.json<ApiRateMetricsStoredRecord>({ validate: isApiRateMetricsStoredRecord }),
        },
        indexes: [{ name: "api-rate-metrics-range", fields: ["partition", "sortKey", "revision"] }],
        defaultOrder: [
            { field: "partition", direction: "asc" },
            { field: "sortKey", direction: "asc" },
            { field: "revision", direction: "asc" },
        ],
        hydrate: (values) =>
            new LegacyApiRateMetricsWrapperEntity(
                values.partition,
                values.logicalKey,
                values.sortKey,
                values.revision,
                values.record,
            ),
    })

    constructor(
        readonly partition: string,
        readonly logicalKey: string,
        readonly sortKey: number,
        readonly revision: number,
        readonly record: ApiRateMetricsStoredRecord,
    ) {}
}

export const LEGACY_API_RATE_METRICS_PARTITION = "records"
