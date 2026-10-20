import { describe, expect, it } from "vitest"
import { describeMcpConnectionError } from "../connection-error"

function refused(address: string): Error {
    return Object.assign(new Error(`connect ECONNREFUSED ${address}`), { code: "ECONNREFUSED" })
}

describe("describeMcpConnectionError", () => {
    it("names the network reason a failed fetch keeps in its cause", () => {
        const error = new TypeError("fetch failed", { cause: refused("127.0.0.1:3000") })

        expect(describeMcpConnectionError(error)).toBe("fetch failed: connect ECONNREFUSED 127.0.0.1:3000")
    })

    it("takes the first address's reason when every address of the host failed", () => {
        const cause = Object.assign(new AggregateError([refused("::1:3000"), refused("127.0.0.1:3000")], ""), {
            code: "ECONNREFUSED",
        })

        expect(describeMcpConnectionError(new TypeError("fetch failed", { cause }))).toBe(
            "fetch failed: connect ECONNREFUSED ::1:3000",
        )
    })

    it("prefixes the code when the reason does not name it", () => {
        const cause = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })

        expect(describeMcpConnectionError(new TypeError("fetch failed", { cause }))).toBe(
            "fetch failed: ECONNRESET: socket hang up",
        )
    })

    it("keeps an error without a cause, or one that already names it, as it is", () => {
        expect(describeMcpConnectionError(new Error("MCP connection timed out after 30000ms: docs"))).toBe(
            "MCP connection timed out after 30000ms: docs",
        )
        const named = new Error("connect ECONNREFUSED 127.0.0.1:3000", { cause: refused("127.0.0.1:3000") })
        expect(describeMcpConnectionError(named)).toBe("connect ECONNREFUSED 127.0.0.1:3000")
        expect(describeMcpConnectionError("closed")).toBe("closed")
    })
})
