import type { AtomicIssueGrant } from "../contracts/issueGrant"

/** Stable issue-token authority. Exchange recovery may publish only through this port. */
export interface IssueGrantPort {
    publish(grant: AtomicIssueGrant): Promise<void>
    readActive(now: number, authorizationRevision: number): Promise<AtomicIssueGrant | null>
    clear(reason: "revoked" | "expired" | "revision_changed" | "deleted"): Promise<void>
}
