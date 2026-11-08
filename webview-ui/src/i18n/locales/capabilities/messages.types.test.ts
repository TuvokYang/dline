import { expect, expectTypeOf, it } from "vitest"
import { translateUi, type UiTranslator } from "../../messages"

// Never execute invalid calls; the owning no-emit check verifies the expected errors.
function assertInvalidCalls(t: UiTranslator) {
    // @ts-expect-error unknown capability key
    t("capabilities.unknown")
    // @ts-expect-error a complete dynamic message requires its named arguments
    t("capabilities.subagent.useMcpResource")
    // @ts-expect-error count remains numeric
    t("capabilities.mcp.toolsCount", { count: "3" })
    // @ts-expect-error static messages take no arguments
    t("capabilities.browser.connected", {})
    // @ts-expect-error both exact server and value are required
    t("capabilities.subagent.useMcpResource", { server: "original" })
}

it("preserves the assembled translator's capability key and named-argument contract", () => {
    expect(translateUi("zh-CN", "capabilities.browser.connected")).toBe("已连接")
    expectTypeOf(assertInvalidCalls).parameter(0).toEqualTypeOf<UiTranslator>()
})
