import { expect } from "@playwright/test"
import { expectComposerText } from "../utils/composer"
import { demo } from "./utils/demo-fixture"

demo("Demo recording harness smoke", async ({ finishRecording, helper, pace, registerRecording, sidebar }) => {
    await helper.signin(sidebar)
    await registerRecording("smoke", { crop: "sidebar", outputWidth: 600 })

    const input = sidebar.getByTestId("chat-input")
    await expect(input).toBeEnabled({ timeout: 30_000 })
    await input.fill("Demo recording smoke")
    await pace(1_000)
    await expectComposerText(input, "Demo recording smoke")

    await finishRecording()
})
