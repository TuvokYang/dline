import type { Command } from "../../kernel"

export type LegacyTaskEffectType =
	| "POST_TASK_VIEW"
	| "PERSIST_SNAPSHOT"
	| "CANCEL_RUNTIME"
	| "PREPARE_RESUME"
	| "START_API"
	| "EXECUTE_TOOL"
	| "APPEND_SAY"
	| "APPEND_ASK"
	| "START_NEW_TASK"
	| "START_SUCCESSOR_TASK"

export interface LegacyTaskEffectLike {
	readonly type: LegacyTaskEffectType
	readonly apiIndex?: number
	readonly dlineTid?: string
	readonly turnId?: string
	readonly interactionId?: string
}

export type LegacyPortAction =
	| { readonly kind: "post_view" }
	| { readonly kind: "persist_snapshot" }
	| { readonly kind: "halt" }
	| { readonly kind: "prepare_resume" }
	| { readonly kind: "provider"; readonly apiIndex?: number }
	| { readonly kind: "tool"; readonly blockId?: string; readonly turnId?: string }
	| { readonly kind: "dialog_say"; readonly interactionId?: string }
	| { readonly kind: "dialog_ask"; readonly interactionId?: string }
	| { readonly kind: "spawn_new" }
	| { readonly kind: "spawn_successor" }

export type CommandAction =
	| { readonly kind: "provider" }
	| { readonly kind: "tool"; readonly blockIds: readonly string[]; readonly turnId: string }
	| { readonly kind: "dialog_prepare"; readonly interactionId: string }
	| { readonly kind: "dialog_reveal"; readonly interactionId: string }
	| { readonly kind: "compose" }
	| { readonly kind: "compaction" }
	| { readonly kind: "policy" }
	| { readonly kind: "halt" }
	| { readonly kind: "spawn" }

export function normalizeLegacyEffect(effect: LegacyTaskEffectLike): LegacyPortAction {
	switch (effect.type) {
		case "POST_TASK_VIEW":
			return { kind: "post_view" }
		case "PERSIST_SNAPSHOT":
			return { kind: "persist_snapshot" }
		case "CANCEL_RUNTIME":
			return { kind: "halt" }
		case "PREPARE_RESUME":
			return { kind: "prepare_resume" }
		case "START_API":
			return { kind: "provider", apiIndex: effect.apiIndex }
		case "EXECUTE_TOOL":
			return { kind: "tool", blockId: effect.dlineTid, turnId: effect.turnId }
		case "APPEND_SAY":
			return { kind: "dialog_say", interactionId: effect.interactionId }
		case "APPEND_ASK":
			return { kind: "dialog_ask", interactionId: effect.interactionId }
		case "START_NEW_TASK":
			return { kind: "spawn_new" }
		case "START_SUCCESSOR_TASK":
			return { kind: "spawn_successor" }
	}
}

export function normalizeCommand(command: Command): CommandAction {
	switch (command.type) {
		case "provider.start":
			return { kind: "provider" }
		case "tool.run":
			return { kind: "tool", blockIds: command.blocks.map((block) => block.blockId), turnId: command.turnId }
		case "dialog.prepare":
			return { kind: "dialog_prepare", interactionId: command.interactionId }
		case "dialog.reveal":
			return { kind: "dialog_reveal", interactionId: command.interactionId }
		case "compose.round":
			return { kind: "compose" }
		case "compaction.run":
			return { kind: "compaction" }
		case "approval.evaluate":
			return { kind: "policy" }
		case "halt.stop":
			return { kind: "halt" }
		case "task.spawn":
			return { kind: "spawn" }
	}
}
