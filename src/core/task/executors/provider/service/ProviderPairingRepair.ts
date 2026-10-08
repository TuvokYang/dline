import { ContextManager } from "@core/context/context-management/ContextManager"
import type { ClineStorageMessage } from "@shared/messages/content"
import cloneDeep from "clone-deep"

/**
 * Rebuild a frozen conversation with canonical tool-call pairing.
 *
 * Journal replay produces paired tool calls by construction, so a provider
 * that still rejects the pairing met history this runtime did not write, such
 * as an imported legacy conversation. The repair drops results that answer no
 * call and supplies the results a call is missing, which is the same canonical
 * projection the conversation would get from a full rebuild.
 *
 * The frozen messages are shared with the in-memory conversation view and the
 * repair edits in place, so it runs on a copy.
 */
export function repairProviderPairing(messages: readonly ClineStorageMessage[]): ClineStorageMessage[] {
	return new ContextManager().repairProviderMessages(cloneDeep([...messages]))
}
