import { createHash } from "node:crypto"

const TASK_PAYLOAD_REF = /^sha256:[a-f0-9]{64}$/

/** Content address of `payload`; equal bytes always share one reference. */
export function taskPayloadRef(payload: Uint8Array): string {
	return `sha256:${createHash("sha256").update(payload).digest("hex")}`
}

/** @throws `InvalidTaskPayloadRef` when `payloadRef` is not a content address. */
export function assertTaskPayloadRef(payloadRef: string): void {
	if (!TASK_PAYLOAD_REF.test(payloadRef)) throw new Error("InvalidTaskPayloadRef")
}
