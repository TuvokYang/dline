import { strict as assert } from "node:assert"
import { describe, it } from "vitest"
import { buildUserFeedbackContent } from "../buildUserFeedbackContent"

describe("buildUserFeedbackContent", () => {
    it("formats running user input as user_message, not feedback", async () => {
        const content = await buildUserFeedbackContent("请按这个方向继续")

        assert.equal(content.length, 1)
        assert.equal(content[0].type, "text")
        assert.match(content[0].text, /<user_message>\n请按这个方向继续\n<\/user_message>/)
        assert.doesNotMatch(content[0].text, /<feedback>/)
    })
})
