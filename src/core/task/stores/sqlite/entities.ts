import { column, defineEntity } from "@core/storage/backend/api/EntitySchema"
import type { Command } from "../../kernel"
import type {
	BackgroundDeliveryProducerKind,
	BackgroundDeliveryRecord,
	BackgroundDeliveryState,
	JournalCausation,
	JournalEntry,
	JournalEntryKind,
	JournalSource,
} from "../contracts"

const JOURNAL_ENTRY_KINDS = [
	"message",
	"tombstone",
	"truncate_boundary",
	"supersede_range",
	"checkpoint_marker",
	"rewind",
] as const satisfies readonly JournalEntryKind[]

const JOURNAL_SOURCES = ["provider", "tool", "dialog", "intake", "system"] as const satisfies readonly JournalSource[]
const BACKGROUND_DELIVERY_PRODUCERS = [
	"command",
	"subagent",
	"subagent_batch",
] as const satisfies readonly BackgroundDeliveryProducerKind[]
const BACKGROUND_DELIVERY_STATES = ["pending", "acknowledged"] as const satisfies readonly BackgroundDeliveryState[]

const CAUSATION_TEXT_FIELDS = ["commandId", "turnId", "interactionId"] as const
const CAUSATION_NUMBER_FIELDS = ["originRevision", "generation"] as const

function isJournalCausation(value: unknown): value is JournalCausation {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false
	const fields = value as Record<string, unknown>
	return (
		CAUSATION_TEXT_FIELDS.every((field) => fields[field] === undefined || typeof fields[field] === "string") &&
		CAUSATION_NUMBER_FIELDS.every((field) => fields[field] === undefined || Number.isSafeInteger(fields[field]))
	)
}

/**
 * One journal record in `journal.db`.
 *
 * Only references are stored here; payload bytes live in {@link PayloadRow}, so
 * loading the whole journal into memory stays cheap.
 */
export class JournalEntryRow {
	static readonly storage = defineEntity<JournalEntryRow>()({
		schemaId: "task-journal-entry",
		version: 1,
		columns: {
			seq: column.integer({ primary: true }),
			operationId: column.text({ unique: true }),
			kind: column.enumText(JOURNAL_ENTRY_KINDS),
			payloadRef: column.text({ nullable: true }),
			source: column.enumText(JOURNAL_SOURCES, { nullable: true }),
			causation: column.json({ nullable: true, validate: isJournalCausation }),
			transientId: column.text({ nullable: true }),
			target: column.integer({ nullable: true }),
			rangeFrom: column.integer({ nullable: true }),
			rangeTo: column.integer({ nullable: true }),
		},
		defaultOrder: [{ field: "seq", direction: "asc" }],
		hydrate: (values) =>
			new JournalEntryRow(
				values.seq,
				values.operationId,
				values.kind,
				values.payloadRef,
				values.source,
				values.causation,
				values.transientId,
				values.target,
				values.rangeFrom,
				values.rangeTo,
			),
	})

	constructor(
		readonly seq: number,
		readonly operationId: string,
		readonly kind: JournalEntryKind,
		readonly payloadRef: string | null,
		readonly source: JournalSource | null,
		readonly causation: JournalCausation | null,
		readonly transientId: string | null,
		readonly target: number | null,
		readonly rangeFrom: number | null,
		readonly rangeTo: number | null,
	) {}

	static fromEntry(entry: JournalEntry): JournalEntryRow {
		return new JournalEntryRow(
			entry.watermark.seq,
			entry.operationId,
			entry.kind,
			entry.payloadRef ?? null,
			entry.source ?? null,
			entry.causation ?? null,
			entry.transientId ?? null,
			entry.target?.seq ?? null,
			entry.range?.from.seq ?? null,
			entry.range?.to.seq ?? null,
		)
	}

	/** The entry this row stores; absent columns stay absent rather than becoming `null`. */
	toEntry(): JournalEntry {
		return {
			version: 1,
			watermark: { seq: this.seq },
			operationId: this.operationId,
			kind: this.kind,
			...(this.payloadRef === null ? {} : { payloadRef: this.payloadRef }),
			...(this.source === null ? {} : { source: this.source }),
			...(this.causation === null ? {} : { causation: this.causation }),
			...(this.transientId === null ? {} : { transientId: this.transientId }),
			...(this.target === null ? {} : { target: { seq: this.target } }),
			...(this.rangeFrom === null || this.rangeTo === null
				? {}
				: { range: { from: { seq: this.rangeFrom }, to: { seq: this.rangeTo } } }),
		}
	}
}

/** Effect of a command that has already been published, so a restart does not publish it again. */
export class CommandPublicationRow {
	static readonly storage = defineEntity<CommandPublicationRow>()({
		schemaId: "task-command-publication",
		version: 1,
		columns: {
			effectKey: column.text({ primary: true }),
			commandId: column.text(),
			originRevision: column.integer(),
			generation: column.integer(),
			commandType: column.text(),
		},
		hydrate: (values) =>
			new CommandPublicationRow(
				values.effectKey,
				values.commandId,
				values.originRevision,
				values.generation,
				values.commandType,
			),
	})

	constructor(
		readonly effectKey: string,
		readonly commandId: string,
		readonly originRevision: number,
		readonly generation: number,
		readonly commandType: string,
	) {}

	static of(command: Command, effectKey: string): CommandPublicationRow {
		return new CommandPublicationRow(effectKey, command.commandId, command.originRevision, command.generation, command.type)
	}
}

/** Producer result retained until canonical background intake durably accepts it. */
export class BackgroundDeliveryRow {
	static readonly storage = defineEntity<BackgroundDeliveryRow>()({
		schemaId: "task-background-delivery",
		version: 1,
		columns: {
			entryId: column.text({ primary: true }),
			producerKind: column.enumText(BACKGROUND_DELIVERY_PRODUCERS),
			producerId: column.text(),
			attempt: column.integer(),
			text: column.text(),
			state: column.enumText(BACKGROUND_DELIVERY_STATES),
		},
		hydrate: (values) =>
			new BackgroundDeliveryRow(
				values.entryId,
				values.producerKind,
				values.producerId,
				values.attempt,
				values.text,
				values.state,
			),
	})

	constructor(
		readonly entryId: string,
		readonly producerKind: BackgroundDeliveryProducerKind,
		readonly producerId: string,
		readonly attempt: number,
		readonly text: string,
		readonly state: BackgroundDeliveryState,
	) {}

	static fromRecord(record: BackgroundDeliveryRecord): BackgroundDeliveryRow {
		return new BackgroundDeliveryRow(
			record.entryId,
			record.producerKind,
			record.producerId,
			record.attempt,
			record.text,
			record.state,
		)
	}

	toRecord(): BackgroundDeliveryRecord {
		return { ...this }
	}
}

/** Content-addressed payload bytes referenced by journal entries and kernel state. */
export class PayloadRow {
	static readonly storage = defineEntity<PayloadRow>()({
		schemaId: "task-payload",
		version: 1,
		columns: {
			ref: column.text({ primary: true }),
			bytes: column.blob(),
		},
		hydrate: (values) => new PayloadRow(values.ref, values.bytes),
	})

	constructor(
		readonly ref: string,
		readonly bytes: Uint8Array,
	) {}
}
