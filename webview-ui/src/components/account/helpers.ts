import type { UsageTransaction as ClineAccountUsageTransaction } from "@shared/ClineAccount"
import type { UsageTransaction as ProtoUsageTransaction, UserOrganization } from "@shared/proto/dline/account"

/** Stable role identity of an organization; display text is resolved by the view. */
export type MainRole = "owner" | "admin" | "member"

/**
 * Pick the highest organization role the service reported.
 *
 * The values are identities, not display text: a view translates them, so a
 * language switch never changes which role was detected.
 */
export const getMainRole = (roles?: string[]): MainRole | undefined => {
    if (!roles) {
        return undefined
    }

    if (roles.includes("owner")) {
        return "owner"
    }
    if (roles.includes("admin")) {
        return "admin"
    }

    return "member"
}

export const getClineUris = (base: string, type: "dashboard" | "credits", route?: "account" | "organization") => {
    const dashboard = new URL("dashboard", base)

    if (type === "dashboard") {
        return dashboard
    }

    const credits = new URL(`/${route ?? "account"}`, dashboard)
    credits.searchParams.set("tab", "credits")
    credits.searchParams.set("redirect", "true")
    return credits
}

/**
 * Converts a protobuf UsageTransaction to a ClineAccount UsageTransaction
 * by adding the missing id and metadata fields
 */
export function convertProtoUsageTransaction(protoTransaction: ProtoUsageTransaction): ClineAccountUsageTransaction {
    return {
        ...protoTransaction,
        id: protoTransaction.generationId, // Use generationId as the id
        metadata: {
            additionalProp1: "",
            additionalProp2: "",
            additionalProp3: "",
        },
    }
}

/**
 * Converts an array of protobuf UsageTransactions to ClineAccount UsageTransactions
 */
export function convertProtoUsageTransactions(protoTransactions: ProtoUsageTransaction[]): ClineAccountUsageTransaction[] {
    return protoTransactions.map(convertProtoUsageTransaction)
}

export const isAdminOrOwner = (activeOrg: UserOrganization): boolean => {
    return activeOrg.roles.findIndex((role) => role === "admin" || role === "owner") > -1
}
