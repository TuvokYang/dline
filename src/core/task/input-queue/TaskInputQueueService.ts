import { getPrompt } from "@core/prompts/i18n"
import { formatResponse } from "@core/prompts/responses"
import { processFilesIntoText } from "@integrations/misc/extract-text"
import type { QueuedInputEntry } from "@shared/InputQueue"
import type { ClineContent } from "@shared/messages"
import { Logger } from "@shared/services/Logger"
import { InputQueueCoordinator } from "./InputQueueCoordinator"
import type { QueueDelivery } from "./InputQueueDelivery"
import type { InputQueueMutation, InputQueueMutationResult } from "./InputQueueMutation"
import type { InputQueueWriteDecision } from "./InputQueueProjection"
import type { InputQueueWriteOutcome } from "./InputQueueWriteTicket"

interface InteractionDispatchResult {
	readonly accepted: boolean
	readonly error?: { readonly code?: string }
}

export interface TaskInputQueuePorts {
	readonly taskId: string
	currentRevision(): number
	persistQueue(): Promise<void>
	publishProjection(): Promise<void>
	submitInteraction(response: {
		readonly taskId: string
		readonly turnId: string
		readonly interactionId: string
		readonly actionId: "reply"
		readonly stateRevision: number
		readonly draft: { readonly text: string; readonly images: string[]; readonly files: string[] }
		readonly presentationDraft: { readonly text: string; readonly images: string[]; readonly files: string[] }
		readonly userInputKind: "queued"
		readonly queuedInputMode: QueueDelivery["kind"]
	}): Promise<InteractionDispatchResult>
	appendUserContent(content: readonly ClineContent[]): void
	presentDeliveredInput(delivery: QueueDelivery): Promise<void>
}

/** Owns retained-input host glue while InputQueueCoordinator owns queue consistency. */
export class TaskInputQueueService {
	private readonly coordinator: InputQueueCoordinator
	private awaitingInteraction?: { readonly turnId: string; readonly interactionId: string }

	constructor(private readonly ports: TaskInputQueuePorts) {
		this.coordinator = new InputQueueCoordinator({
			persistQueue: () => this.ports.persistQueue(),
			publishProjection: () => this.ports.publishProjection(),
			answerTurnEnd: (delivery) => this.answerTurnEnd(delivery),
			stageToolRoundInput: (delivery) => this.stageToolRoundInput(delivery),
			presentDeliveredInput: (delivery) => this.ports.presentDeliveredInput(delivery),
		})
	}

	snapshot(): QueuedInputEntry[] {
		return this.coordinator.snapshot()
	}

	serialize(): QueuedInputEntry[] {
		return this.coordinator.serialize()
	}

	mutate(mutation: InputQueueMutation): Promise<InputQueueMutationResult> {
		return this.mutateAndWake(mutation)
	}

	markAwaitingUser(interaction: { readonly turnId: string; readonly interactionId: string }): void {
		this.awaitingInteraction = interaction
		void this.coordinator.deliverAtTurnEnd()
	}

	deliverAtToolRound(): Promise<void> {
		return this.coordinator.deliverAtToolRound()
	}

	settleStagedDelivery(delivered: boolean): Promise<void> {
		return this.coordinator.settleStagedDelivery(delivered)
	}

	get hasStagedDelivery(): boolean {
		return this.coordinator.hasStagedDelivery
	}

	runExclusive<T>(section: () => Promise<T>): Promise<T> {
		return this.coordinator.runExclusive(section)
	}

	adoptPersisted(entries: unknown): void {
		this.coordinator.adoptPersisted(entries)
	}

	markQueueAbsent(): void {
		this.coordinator.markQueueAbsent()
	}

	markQueueUnreadable(): void {
		this.coordinator.markQueueUnreadable()
	}

	get droppedInFlightCount(): number {
		return this.coordinator.droppedInFlightCount
	}

	resolveSnapshotWrite(persisted: QueuedInputEntry[] | undefined): InputQueueWriteDecision {
		return this.coordinator.resolveSnapshotWrite(persisted)
	}

	recordSnapshotWriteOutcome(outcome: InputQueueWriteOutcome): void {
		this.coordinator.recordSnapshotWriteOutcome(outcome)
	}

	private async mutateAndWake(mutation: InputQueueMutation): Promise<InputQueueMutationResult> {
		const result = await this.coordinator.mutate(mutation)
		if (result.accepted && this.awaitingInteraction) {
			void this.coordinator.deliverAtTurnEnd()
		}
		return result
	}

	private async answerTurnEnd(delivery: QueueDelivery): Promise<boolean> {
		const awaiting = this.awaitingInteraction
		if (!awaiting) return false
		const modelBlocks = this.renderModelBlocks(delivery)
		const result = await this.ports.submitInteraction({
			taskId: this.ports.taskId,
			turnId: awaiting.turnId,
			interactionId: awaiting.interactionId,
			actionId: "reply",
			stateRevision: this.ports.currentRevision(),
			draft: { text: modelBlocks.join("\n\n"), images: [...delivery.images], files: [...delivery.files] },
			presentationDraft: {
				text: delivery.entries.map((entry) => entry.text).join("\n\n"),
				images: [...delivery.images],
				files: [...delivery.files],
			},
			userInputKind: "queued",
			queuedInputMode: delivery.kind,
		})
		if (this.awaitingInteraction === awaiting) this.awaitingInteraction = undefined
		if (!result.accepted) {
			Logger.warn(`[inputQueue] Turn-end delivery rejected: ${result.error?.code ?? "unknown"}`)
		}
		return result.accepted
	}

	private async stageToolRoundInput(delivery: QueueDelivery): Promise<void> {
		const staged: ClineContent[] = this.renderModelBlocks(delivery).map((text) => ({ type: "text", text }))
		if (delivery.images.length > 0) staged.push(...formatResponse.imageBlocks([...delivery.images]))
		if (delivery.files.length > 0) {
			const fileContent = await processFilesIntoText([...delivery.files])
			if (fileContent) staged.push({ type: "text", text: fileContent })
		}
		this.ports.appendUserContent(staged)
	}

	private renderModelBlocks(delivery: QueueDelivery): string[] {
		const description = escapeXmlAttribute(getPrompt("inputQueue", "auxiliaryAlignmentV1", "en"))
		return delivery.blocks.map((block) => `<user_message description="${description}">\n${block}\n</user_message>`)
	}
}

function escapeXmlAttribute(value: string): string {
	return value
		.replace(/&/g, "&" + "amp;")
		.replace(/"/g, "&" + "quot;")
		.replace(/</g, "&" + "lt;")
		.replace(/>/g, "&" + "gt;")
		.replace(/'/g, "&" + "apos;")
}
