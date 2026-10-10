import { stableJsonStringify } from "@shared/stable-json"
import type { JournalEntry, JournalEntryKind } from "./contracts"

type EntryContent = Omit<JournalEntry, "version" | "operationId" | "kind" | "watermark">

/** Stable semantic identity; execution causation and transient UI identity are replay metadata. */
export function journalOperationFingerprint(kind: JournalEntryKind, content: EntryContent): string {
    const { causation: _causation, transientId: _transientId, ...semanticContent } = content
    return stableJsonStringify({ kind, content: semanticContent })
}
