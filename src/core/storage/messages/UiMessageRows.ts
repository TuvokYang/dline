import type { UiMessage } from "@/shared/ExtensionMessage"
import { column, defineEntity } from "../backend/api/EntitySchema"

const MESSAGE_TYPES = ["ask", "say"] as const
const ATTACHMENT_KINDS = ["images", "files"] as const

type MessageType = (typeof MESSAGE_TYPES)[number]
type AttachmentKind = (typeof ATTACHMENT_KINDS)[number]
type JsonObject = Record<string, unknown>

/** Fields stored as their own text column. */
const TEXT_FIELDS = [
	"ask",
	"say",
	"text",
	"reasoning",
	"commandStatus",
	"commandExecutionMode",
	"interactionId",
	"userInputKind",
	"queuedInputMode",
	"activityId",
	"logPath",
	"lastCheckpointHash",
] as const
const BOOLEAN_FIELDS = [
	"partial",
	"commandCanMoveToBackground",
	"isCheckpointCheckedOut",
	"completionHasChanges",
	"isOperationOutsideWorkspace",
] as const
const REAL_FIELDS = ["commandTs"] as const
const INTEGER_FIELDS = ["exitCode", "conversationHistoryIndex"] as const
const OBJECT_FIELDS = ["modelInfo", "imageGeneration", "compactionConversationRange"] as const
const RANGE_FIELD = "conversationHistoryDeletedRange"

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNumberPair(value: unknown): value is [number, number] {
	return Array.isArray(value) && value.length === 2 && value.every((item) => typeof item === "number" && Number.isFinite(item))
}

function isStringList(value: unknown): value is string[] {
	return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string")
}

export interface UiMessageRowValues {
	readonly ordinal: number
	readonly ts: number
	readonly type: MessageType
	readonly ask: string | null
	readonly say: string | null
	readonly text: string | null
	readonly reasoning: string | null
	readonly commandStatus: string | null
	readonly commandExecutionMode: string | null
	readonly interactionId: string | null
	readonly userInputKind: string | null
	readonly queuedInputMode: string | null
	readonly activityId: string | null
	readonly logPath: string | null
	readonly lastCheckpointHash: string | null
	readonly partial: boolean | null
	readonly commandCanMoveToBackground: boolean | null
	readonly isCheckpointCheckedOut: boolean | null
	readonly completionHasChanges: boolean | null
	readonly isOperationOutsideWorkspace: boolean | null
	readonly commandTs: number | null
	readonly exitCode: number | null
	readonly conversationHistoryIndex: number | null
	readonly modelInfo: JsonObject | null
	readonly imageGeneration: JsonObject | null
	readonly compactionConversationRange: JsonObject | null
	readonly conversationHistoryDeletedRange: [number, number] | null
	/** Fields without a column, or whose value does not fit its column, kept verbatim. */
	readonly extra: JsonObject | null
}

/** One chat row in `messages.db`, ordered by `ordinal`. */
export class UiMessageRow implements UiMessageRowValues {
	static readonly storage = defineEntity<UiMessageRow>()({
		schemaId: "task-ui-message",
		version: 1,
		columns: {
			ordinal: column.integer({ primary: true }),
			// Not unique: the stored history may repeat a timestamp, and a constraint
			// would make an ordinary append fail instead of preserving what was shown.
			ts: column.real({ indexed: true }),
			type: column.enumText(MESSAGE_TYPES),
			ask: column.text({ nullable: true }),
			say: column.text({ nullable: true }),
			text: column.text({ nullable: true }),
			reasoning: column.text({ nullable: true }),
			commandStatus: column.text({ nullable: true }),
			commandExecutionMode: column.text({ nullable: true }),
			interactionId: column.text({ nullable: true }),
			userInputKind: column.text({ nullable: true }),
			queuedInputMode: column.text({ nullable: true }),
			activityId: column.text({ nullable: true }),
			logPath: column.text({ nullable: true }),
			lastCheckpointHash: column.text({ nullable: true }),
			partial: column.boolean({ nullable: true }),
			commandCanMoveToBackground: column.boolean({ nullable: true }),
			isCheckpointCheckedOut: column.boolean({ nullable: true }),
			completionHasChanges: column.boolean({ nullable: true }),
			isOperationOutsideWorkspace: column.boolean({ nullable: true }),
			commandTs: column.real({ nullable: true }),
			exitCode: column.integer({ nullable: true }),
			conversationHistoryIndex: column.integer({ nullable: true }),
			modelInfo: column.json({ nullable: true, validate: isJsonObject }),
			imageGeneration: column.json({ nullable: true, validate: isJsonObject }),
			compactionConversationRange: column.json({ nullable: true, validate: isJsonObject }),
			conversationHistoryDeletedRange: column.json({ nullable: true, validate: isNumberPair }),
			extra: column.json({ nullable: true, validate: isJsonObject }),
		},
		defaultOrder: [{ field: "ordinal", direction: "asc" }],
		hydrate: (values) => new UiMessageRow(values),
	})

	declare readonly ordinal: number
	declare readonly ts: number
	declare readonly type: MessageType
	declare readonly ask: string | null
	declare readonly say: string | null
	declare readonly text: string | null
	declare readonly reasoning: string | null
	declare readonly commandStatus: string | null
	declare readonly commandExecutionMode: string | null
	declare readonly interactionId: string | null
	declare readonly userInputKind: string | null
	declare readonly queuedInputMode: string | null
	declare readonly activityId: string | null
	declare readonly logPath: string | null
	declare readonly lastCheckpointHash: string | null
	declare readonly partial: boolean | null
	declare readonly commandCanMoveToBackground: boolean | null
	declare readonly isCheckpointCheckedOut: boolean | null
	declare readonly completionHasChanges: boolean | null
	declare readonly isOperationOutsideWorkspace: boolean | null
	declare readonly commandTs: number | null
	declare readonly exitCode: number | null
	declare readonly conversationHistoryIndex: number | null
	declare readonly modelInfo: JsonObject | null
	declare readonly imageGeneration: JsonObject | null
	declare readonly compactionConversationRange: JsonObject | null
	declare readonly conversationHistoryDeletedRange: [number, number] | null
	declare readonly extra: JsonObject | null

	constructor(values: UiMessageRowValues) {
		Object.assign(this, values)
	}
}

/** One image or file reference of a chat row, kept in list order by `position`. */
export class UiMessageAttachmentRow {
	static readonly storage = defineEntity<UiMessageAttachmentRow>()({
		schemaId: "task-ui-message-attachment",
		version: 1,
		columns: {
			key: column.text({ primary: true }),
			ordinal: column.integer({ indexed: true }),
			kind: column.enumText(ATTACHMENT_KINDS),
			position: column.integer(),
			value: column.text(),
		},
		defaultOrder: [
			{ field: "ordinal", direction: "asc" },
			{ field: "position", direction: "asc" },
		],
		hydrate: (values) => new UiMessageAttachmentRow(values.ordinal, values.kind, values.position, values.value),
	})

	readonly key: string

	constructor(
		readonly ordinal: number,
		readonly kind: AttachmentKind,
		readonly position: number,
		readonly value: string,
	) {
		this.key = `${ordinal}:${kind}:${position}`
	}
}

/** A chat message at its position in the stored history. */
export interface UiMessageRecord {
	readonly ordinal: number
	readonly ts: number
	readonly message: UiMessage
}

export interface EncodedUiMessage {
	readonly row: UiMessageRow
	readonly attachments: readonly UiMessageAttachmentRow[]
}

/** Whether `value` can be stored as a chat row: a message with a positive timestamp and a known type. */
export function isStorableMessage(value: unknown): value is UiMessage {
	if (!isJsonObject(value)) return false
	return (
		typeof value.ts === "number" &&
		Number.isFinite(value.ts) &&
		value.ts > 0 &&
		MESSAGE_TYPES.includes(value.type as MessageType)
	)
}

/**
 * Splits a message into its row and attachments without losing anything: a field
 * with no column, or a value its column cannot hold, is kept in `extra`.
 */
export function encodeUiMessage(message: UiMessage, ordinal: number): EncodedUiMessage {
	const rest: JsonObject = { ...message }
	const extra: JsonObject = {}
	const values: Record<string, unknown> = { ordinal, ts: message.ts, type: message.type }
	delete rest.ts
	delete rest.type

	const take = (field: string, fits: (value: unknown) => boolean): void => {
		if (!(field in rest)) {
			values[field] = null
			return
		}
		const value = rest[field]
		delete rest[field]
		if (value === undefined) values[field] = null
		else if (fits(value)) values[field] = value
		else {
			values[field] = null
			extra[field] = value
		}
	}
	for (const field of TEXT_FIELDS) take(field, (value) => typeof value === "string")
	for (const field of BOOLEAN_FIELDS) take(field, (value) => typeof value === "boolean")
	for (const field of REAL_FIELDS) take(field, (value) => typeof value === "number" && Number.isFinite(value))
	for (const field of INTEGER_FIELDS) take(field, (value) => Number.isSafeInteger(value))
	for (const field of OBJECT_FIELDS) take(field, isJsonObject)
	take(RANGE_FIELD, isNumberPair)

	const attachments: UiMessageAttachmentRow[] = []
	for (const kind of ATTACHMENT_KINDS) {
		if (!(kind in rest)) continue
		const value = rest[kind]
		delete rest[kind]
		if (value === undefined) continue
		if (!isStringList(value)) {
			extra[kind] = value
			continue
		}
		value.forEach((item, position) => attachments.push(new UiMessageAttachmentRow(ordinal, kind, position, item)))
	}
	for (const [field, value] of Object.entries(rest)) {
		if (value !== undefined) extra[field] = value
	}
	values.extra = Object.keys(extra).length > 0 ? extra : null
	return { row: new UiMessageRow(values as unknown as UiMessageRowValues), attachments }
}

const COLUMN_FIELDS = [
	...TEXT_FIELDS,
	...BOOLEAN_FIELDS,
	...REAL_FIELDS,
	...INTEGER_FIELDS,
	...OBJECT_FIELDS,
	RANGE_FIELD,
] as const

/** The message a row and its attachments store; the inverse of {@link encodeUiMessage}. */
export function decodeUiMessage(row: UiMessageRow, attachments: readonly UiMessageAttachmentRow[]): UiMessage {
	const message: Record<string, unknown> = { ts: row.ts, type: row.type }
	for (const field of COLUMN_FIELDS) {
		const value = row[field]
		if (value !== null) message[field] = value
	}
	for (const kind of ATTACHMENT_KINDS) {
		const values = attachments
			.filter((attachment) => attachment.kind === kind)
			.sort((left, right) => left.position - right.position)
			.map((attachment) => attachment.value)
		if (values.length > 0) message[kind] = values
	}
	if (row.extra) Object.assign(message, row.extra)
	return message as unknown as UiMessage
}
