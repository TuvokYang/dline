import { createHash } from "node:crypto"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame } from "@playwright/test"
import { ImageGenerationSource } from "@shared/proto/dline/profile"

const PNG_1X1_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=="
const GENERATED_ARTIFACT_ID = `image:sha256:${createHash("sha256").update(Buffer.from(PNG_1X1_BASE64, "base64")).digest("hex")}`

async function updateSettings(dlineDir: string, updates: Record<string, unknown>): Promise<void> {
	const filePath = path.join(dlineDir, "data", "settings", "settings.json")
	const settings = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>
	await writeFile(filePath, `${JSON.stringify({ ...settings, ...updates }, null, 2)}\n`, "utf8")
}

async function configureCurrentCapableImageProfile(dlineDir: string): Promise<void> {
	const settingsDir = path.join(dlineDir, "data", "settings")
	const profilesPath = path.join(settingsDir, "api_profiles.json")
	const profiles = JSON.parse(await readFile(profilesPath, "utf8")) as Array<Record<string, unknown>>
	const profile = profiles.find((candidate) => candidate.name === E2E_PROFILE_NAMES.mockOpenAiResponses)
	if (!profile) throw new Error("Current image E2E profile is unavailable")
	profile.modelId = "gpt-5.6-sol"
	profile.imageSource = "IMAGE_GENERATION_SOURCE_UNSPECIFIED"
	delete profile.imageProfileId
	delete profile.imageModelId
	const openai = profile.openai as Record<string, unknown> | undefined
	if (!openai) throw new Error("Current image E2E profile has no OpenAI configuration")
	delete openai.apiFormat
	openai.customModelEnabled = false
	delete openai.capabilities
	delete openai.pricing
	await writeFile(profilesPath, `${JSON.stringify(profiles, null, 2)}\n`, "utf8")
	await writeFile(path.join(settingsDir, "image_generation_profiles.json"), "[]\n", "utf8")
	await updateSettings(dlineDir, {
		actModeProfile: E2E_PROFILE_NAMES.mockOpenAiResponses,
		planModeProfile: E2E_PROFILE_NAMES.mockOpenAiResponses,
		imageGenerationEnabled: false,
		clineWebToolsEnabled: false,
	})
}

async function configureManualImageProfile(dlineDir: string): Promise<void> {
	await configureCurrentCapableImageProfile(dlineDir)
	const profilesPath = path.join(dlineDir, "data", "settings", "api_profiles.json")
	const profiles = JSON.parse(await readFile(profilesPath, "utf8")) as Array<Record<string, unknown>>
	const profile = profiles.find((candidate) => candidate.name === E2E_PROFILE_NAMES.mockOpenAiResponses)
	if (!profile) throw new Error("Current image E2E profile is unavailable")
	profile.imageSource = "IMAGE_GENERATION_SOURCE_GPT_SUBSCRIPTION"
	profile.imageModelId = "gpt-image-2.5"
	await writeFile(profilesPath, `${JSON.stringify(profiles, null, 2)}\n`, "utf8")
	await updateSettings(dlineDir, { imageGenerationEnabled: true })
}

async function setManualImageApproval(sidebar: Frame): Promise<void> {
	await sidebar.getByLabel("Open auto-approve settings").click()
	const checkbox = sidebar.locator("vscode-checkbox").filter({ hasText: "Generate images" })
	await expect(checkbox).toHaveCount(1)
	if (await checkbox.evaluate((element) => Boolean((element as HTMLInputElement).checked))) {
		await sidebar.getByText("Generate images", { exact: true }).click()
	}
	await expect.poll(() => checkbox.evaluate((element) => Boolean((element as HTMLInputElement).checked))).toBe(false)
	await sidebar.getByLabel("Close auto-approve settings").click()
}

async function setImageAndProjectReadAutoApproval(sidebar: Frame): Promise<void> {
	await sidebar.getByLabel("Open auto-approve settings").click()
	const setChecked = async (label: string, checked: boolean): Promise<void> => {
		const checkbox = sidebar.locator("vscode-checkbox").filter({ hasText: label })
		await expect(checkbox).toHaveCount(1)
		const isChecked = () => checkbox.evaluate((element) => Boolean((element as HTMLInputElement).checked))
		if ((await isChecked()) !== checked) await sidebar.getByText(label, { exact: true }).click()
		await expect.poll(isChecked).toBe(checked)
	}
	await setChecked("Generate images", true)
	await setChecked("Read project files", true)
	await setChecked("Read all files", false)
	await sidebar.getByLabel("Close auto-approve settings").click()
}

async function sendTask(sidebar: Frame, text: string): Promise<void> {
	const input = sidebar.getByTestId("chat-input")
	await input.fill(text)
	await sidebar.getByTestId("send-button").click()
	await expect(input).toHaveValue("")
	await expect(sidebar.getByText(text, { exact: true }).first()).toBeVisible()
}

async function findFiles(root: string, fileName: string): Promise<string[]> {
	const matches: string[] = []
	for (const entry of await readdir(root, { withFileTypes: true })) {
		const entryPath = path.join(root, entry.name)
		if (entry.isDirectory()) matches.push(...(await findFiles(entryPath, fileName)))
		else if (entry.name === fileName) matches.push(entryPath)
	}
	return matches
}

function getFrozenToolName(tool: unknown): string | undefined {
	if (typeof tool !== "object" || tool === null) return undefined
	const record = tool as { name?: unknown; function?: { name?: unknown } }
	if (typeof record.function?.name === "string") return record.function.name
	return typeof record.name === "string" ? record.name : undefined
}

async function listFilesRecursively(root: string): Promise<string[]> {
	let entries
	try {
		entries = await readdir(root, { withFileTypes: true })
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
		throw error
	}
	const files: string[] = []
	for (const entry of entries) {
		const entryPath = path.join(root, entry.name)
		if (entry.isDirectory()) files.push(...(await listFilesRecursively(entryPath)))
		else files.push(entryPath)
	}
	return files
}

e2e(
	"Image generation - Feature off keeps generate_image out of the provider tool schema",
	async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(120_000)
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses({
			type: "tool",
			id: "call_image_gate_off_completion",
			name: "attempt_completion",
			arguments: { result: "E2E_IMAGE_GATE_OFF_OK" },
			expectedRequestExcludes: ['"generate_image"'],
		})

		const app = await openVSCode(workspaceDir)
		try {
			const page = await app.firstWindow()
			await E2ETestHelper.openClineSidebar(page)
			const sidebar = await helper.getSidebar(page)
			await helper.signin(sidebar)
			await sendTask(sidebar, "Complete without generating an image while the Image Generation feature is disabled.")
			await expect(sidebar.getByText("E2E_IMAGE_GATE_OFF_OK", { exact: false }).last()).toBeVisible({ timeout: 60_000 })

			const consumptions = server.getMockConsumptions("openai-compatible-chat")
			expect(consumptions).toHaveLength(1)
			expect(consumptions[0].contractError).toBeUndefined()
			expect(JSON.stringify(consumptions[0].requestBody)).not.toContain("generate_image")
			expect(server.getOpenAIImageConsumptions()).toHaveLength(0)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)

e2e(
	"Image generation - Global feature on with Profile source None keeps generate_image unavailable",
	async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(120_000)
		await configureCurrentCapableImageProfile(dlineDir)
		await updateSettings(dlineDir, { imageGenerationEnabled: true })
		server.resetOpenAiMock()
		server.enqueueResponses("openai-compatible-responses", {
			type: "tool",
			id: "call_image_source_none_completion",
			name: "attempt_completion",
			arguments: { result: "E2E_IMAGE_SOURCE_NONE_OK" },
			expectedRequestExcludes: ['"generate_image"'],
		})

		const app = await openVSCode(workspaceDir)
		try {
			const page = await app.firstWindow()
			await E2ETestHelper.openClineSidebar(page)
			const sidebar = await helper.getSidebar(page)
			await helper.signin(sidebar)
			await sendTask(sidebar, "Complete without generating an image because this Profile has Image source None.")
			await expect(sidebar.getByText("E2E_IMAGE_SOURCE_NONE_OK", { exact: false }).last()).toBeVisible({ timeout: 60_000 })

			const consumptions = server.getMockConsumptions("openai-compatible-responses")
			expect(consumptions).toHaveLength(1)
			expect(consumptions[0].contractError).toBeUndefined()
			expect(JSON.stringify(consumptions[0].requestBody)).not.toContain("generate_image")
			expect(server.getOpenAIImageConsumptions()).toHaveLength(0)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)

e2e(
	"Image generation - manual Reject and Approve keep typed cards across task reopen",
	async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(180_000)
		await configureManualImageProfile(dlineDir)
		server.resetOpenAiMock()
		const rejectedPrompt = "One blue owl awaiting approval"
		const approvedPrompt = "One green owl after approval"
		const rejectedTask = "Request one image, but wait for my manual decision."
		const approvedTask = "Request one image after I explicitly approve."
		const hostedImageConsumptions = () =>
			server
				.getMockConsumptions("openai-compatible-responses")
				.filter((entry) => entry.responseType === "hosted-image-generation")
		server.enqueueResponses(
			"openai-compatible-responses",
			{ type: "tool", id: "call_image_rejected", name: "generate_image", arguments: { prompt: rejectedPrompt, count: 1 } },
			{
				type: "tool",
				id: "call_image_rejection_done",
				name: "attempt_completion",
				arguments: { result: "E2E_IMAGE_REJECTED_OK" },
			},
			{ type: "tool", id: "call_image_approved", name: "generate_image", arguments: { prompt: approvedPrompt, count: 1 } },
			{
				type: "hosted-image-generation",
				id: "ig_manual_approved_e2e",
				b64Json: PNG_1X1_BASE64,
				revisedPrompt: approvedPrompt,
			},
			{
				type: "tool",
				id: "call_image_approval_done",
				name: "attempt_completion",
				arguments: { result: "E2E_IMAGE_APPROVED_OK" },
				expectedToolResults: [{ callId: "call_image_approved", contentIncludes: "reference_artifact_ids" }],
			},
		)

		const app = await openVSCode(workspaceDir)
		try {
			const page = await app.firstWindow()
			await E2ETestHelper.openClineSidebar(page)
			const sidebar = await helper.getSidebar(page)
			await helper.signin(sidebar)
			await setManualImageApproval(sidebar)
			await sendTask(sidebar, rejectedTask)
			const pendingCard = sidebar.getByRole("contentinfo").getByTestId("presentation-tool_approval")
			await expect(pendingCard.getByText("Dline wants to generate an image", { exact: true })).toBeVisible({
				timeout: 60_000,
			})
			await expect(sidebar.getByText("Dline wants to generate an image", { exact: true })).toHaveCount(1)
			await expect(pendingCard.getByText(rejectedPrompt, { exact: true })).toBeVisible()
			await expect(pendingCard.getByText("2 images requested", { exact: true })).toHaveCount(0)
			await expect(sidebar.getByRole("contentinfo").getByText("Reject", { exact: true })).toBeVisible()
			expect(server.getMockConsumptions("openai-compatible-responses")).toHaveLength(1)
			expect(hostedImageConsumptions()).toHaveLength(0)

			await sidebar.getByRole("button", { name: "Close Task", exact: true }).click()
			await page.getByRole("button", { name: "History", exact: true }).click()
			await E2ETestHelper.dismissWhatsNewModal(sidebar)
			await sidebar.locator(".history-item").filter({ hasText: rejectedTask }).click()
			await expect(pendingCard.getByText("Dline wants to generate an image", { exact: true })).toBeVisible()
			await expect(sidebar.getByText("Dline wants to generate an image", { exact: true })).toHaveCount(1)
			await expect(pendingCard.getByText(rejectedPrompt, { exact: true })).toBeVisible()
			expect(hostedImageConsumptions()).toHaveLength(0)
			await sidebar.getByRole("contentinfo").getByText("Reject", { exact: true }).click()
			await expect(sidebar.getByText("Image generation rejected", { exact: true }).last()).toBeVisible()
			await expect(sidebar.getByText(rejectedPrompt, { exact: true }).last()).toBeVisible()
			expect(hostedImageConsumptions()).toHaveLength(0)
			await expect(sidebar.getByText("E2E_IMAGE_REJECTED_OK", { exact: false }).last()).toBeVisible({ timeout: 60_000 })

			await sidebar.getByRole("button", { name: "Close Task", exact: true }).click()
			await sendTask(sidebar, approvedTask)
			await expect(pendingCard.getByText("Dline wants to generate an image", { exact: true })).toBeVisible({
				timeout: 60_000,
			})
			await expect(sidebar.getByText("Dline wants to generate an image", { exact: true })).toHaveCount(1)
			await expect(pendingCard.getByText(approvedPrompt, { exact: true })).toBeVisible()
			expect(hostedImageConsumptions()).toHaveLength(0)
			await sidebar.getByRole("contentinfo").getByText("Approve", { exact: true }).click()
			await expect(sidebar.getByText("E2E_IMAGE_APPROVED_OK", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
			await expect(sidebar.getByText("Image generation completed", { exact: true }).last()).toBeVisible()
			const consumptions = server.getMockConsumptions("openai-compatible-responses")
			expect(consumptions).toHaveLength(5)
			expect(consumptions.map((entry) => entry.responseType)).toEqual([
				"tool",
				"tool",
				"tool",
				"hosted-image-generation",
				"tool",
			])
			expect(consumptions.every((entry) => entry.contractError === undefined)).toBe(true)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)

e2e(
	"Image generation - GPT Subscription routes OpenAI Responses generation and ref-based edit",
	async ({ dlineDir, dlineDocsDir, helper, openVSCode, server, userDataDir, workspaceDir }, testInfo) => {
		e2e.setTimeout(180_000)
		await configureCurrentCapableImageProfile(dlineDir)
		server.resetOpenAiMock()
		server.enqueueResponses(
			"openai-compatible-responses",
			{
				type: "tool",
				id: "call_hosted_generate_image",
				name: "generate_image",
				arguments: {
					prompt: "A hosted deterministic blue owl",
					count: 1,
					width: 2048,
					height: 1152,
					quality: "high",
					output_format: "png",
					background: "opaque",
				},
				expectedRequestIncludes: ['"name":"generate_image"'],
				expectedRequestExcludes: ['"type":"image_generation"'],
			},
			{
				type: "hosted-image-generation",
				id: "ig_hosted_e2e",
				b64Json: PNG_1X1_BASE64,
				partialImages: [PNG_1X1_BASE64, PNG_1X1_BASE64, PNG_1X1_BASE64],
				delayMs: 3_000,
				afterPartialImageDelayMs: 500,
				revisedPrompt: "A hosted deterministic blue owl",
				expectedRequestIncludes: [
					'"type":"image_generation"',
					'"model":"gpt-image-2"',
					'"action":"generate"',
					'"partial_images":3',
					'"text":"A hosted deterministic blue owl\\n\\n横版 16:9"',
					'"quality":"high"',
					'"background":"opaque"',
					'"output_format":"png"',
					'"tool_choice":{"type":"image_generation"}',
					'"store":false',
				],
				expectedRequestExcludes: ['"name":"generate_image"', '"size":'],
			},
			{
				type: "tool",
				id: "call_current_edit_image",
				name: "generate_image",
				arguments: {
					prompt: "Edit the generated owl with a gold border",
					count: 1,
					width: 2048,
					height: 1152,
					output_format: "png",
					reference_artifact_ids: [GENERATED_ARTIFACT_ID],
				},
				expectedToolResults: [{ callId: "call_hosted_generate_image", contentIncludes: "reference_artifact_ids" }],
				expectedRequestExcludes: [PNG_1X1_BASE64, "data:image/"],
			},
			{
				type: "hosted-image-generation",
				id: "ig_current_edit_e2e",
				b64Json: PNG_1X1_BASE64,
				delayMs: 10_000,
				revisedPrompt: "Edit the generated owl with a gold border",
				expectedRequestIncludes: [
					'"type":"image_generation"',
					'"model":"gpt-image-2"',
					'"action":"edit"',
					'"type":"input_image"',
					'"text":"Edit the generated owl with a gold border\\n\\n横版 16:9"',
					'"tool_choice":{"type":"image_generation"}',
					'"store":false',
				],
				expectedRequestExcludes: ['"name":"generate_image"', '"size":'],
			},
		)

		const app = await openVSCode(workspaceDir)
		try {
			const page = await app.firstWindow()
			await E2ETestHelper.openClineSidebar(page)
			const sidebar = await helper.getSidebar(page)
			await helper.signin(sidebar)
			await page.getByRole("button", { name: "Settings", exact: true }).click()
			await expect(sidebar.getByRole("heading", { name: "API Configuration" })).toBeVisible()
			await expect(sidebar.getByRole("combobox", { name: "Image source", exact: true })).toHaveCount(0)

			await sidebar.getByTestId("tab-features").click()
			await expect(sidebar.getByRole("heading", { name: "Feature Settings" })).toBeVisible()
			const imageGenerationToggle = sidebar
				.getByText("Enable Image Generation", { exact: true })
				.locator("..")
				.getByRole("switch")
			await expect(imageGenerationToggle).toHaveAttribute("aria-checked", "false")
			await imageGenerationToggle.click()
			await expect(imageGenerationToggle).toHaveAttribute("aria-checked", "true")
			const settingsPath = path.join(dlineDir, "data", "settings", "settings.json")
			await E2ETestHelper.waitUntil(async () => {
				const settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>
				return settings.imageGenerationEnabled === true
			})

			await sidebar.getByTestId("tab-api-config").click()
			await expect(sidebar.getByRole("heading", { name: "API Configuration" })).toBeVisible()
			await sidebar.getByRole("button", { name: `Expand ${E2E_PROFILE_NAMES.mockOpenAiResponses}`, exact: true }).click()
			const profileCard = sidebar
				.getByTestId("api-profile-card")
				.filter({ has: sidebar.locator(`input[value="${E2E_PROFILE_NAMES.mockOpenAiResponses}"]`) })
			await expect(profileCard).toHaveCount(1)
			const imageSource = profileCard.getByRole("combobox", { name: "Image source", exact: true })
			await expect(imageSource).toBeVisible()
			await expect(imageSource).toHaveValue(String(ImageGenerationSource.IMAGE_GENERATION_SOURCE_UNSPECIFIED))
			await expect(imageSource.getByRole("option", { name: "None", exact: true })).toBeEnabled()
			await expect(imageSource.getByRole("option", { name: "Independent", exact: true })).toHaveCount(0)
			await expect(imageSource.getByRole("option", { name: "GPT Subscription", exact: true })).toBeEnabled()
			await imageSource.selectOption({ label: "GPT Subscription" })
			await expect(imageSource).toHaveValue(String(ImageGenerationSource.IMAGE_GENERATION_SOURCE_GPT_SUBSCRIPTION))
			const imageModel = profileCard.getByRole("combobox", { name: "Image model", exact: true })
			await expect(imageModel).toHaveValue("gpt-image-2.5")
			await expect(imageModel.getByRole("option", { name: "GPT Image 1", exact: true })).toBeEnabled()
			await expect(imageModel.getByRole("option", { name: "GPT Image 2", exact: true })).toBeEnabled()
			await expect(imageModel.getByRole("option", { name: "GPT Image 2.5", exact: true })).toBeEnabled()
			await expect(imageModel.getByRole("option", { name: "GPT Image 2 (Subscription)", exact: true })).toHaveCount(0)
			await imageModel.selectOption("gpt-image-1")
			await expect(imageModel).toHaveValue("gpt-image-1")
			await imageModel.selectOption("gpt-image-2.5")
			await expect(imageModel).toHaveValue("gpt-image-2.5")
			const profilesPath = path.join(dlineDir, "data", "settings", "api_profiles.json")
			await E2ETestHelper.waitUntil(async () => {
				const profiles = JSON.parse(await readFile(profilesPath, "utf8")) as Array<Record<string, unknown>>
				return profiles.some(
					(profile) =>
						profile.name === E2E_PROFILE_NAMES.mockOpenAiResponses &&
						profile.imageSource === "IMAGE_GENERATION_SOURCE_GPT_SUBSCRIPTION" &&
						profile.imageModelId === "gpt-image-2.5",
				)
			})
			const persistedProfiles = JSON.parse(await readFile(profilesPath, "utf8")) as Array<Record<string, unknown>>
			const persistedProfile = persistedProfiles.find((profile) => profile.name === E2E_PROFILE_NAMES.mockOpenAiResponses)
			expect(persistedProfile).toMatchObject({
				modelId: "gpt-5.6-sol",
				imageSource: "IMAGE_GENERATION_SOURCE_GPT_SUBSCRIPTION",
				imageModelId: "gpt-image-2.5",
			})
			expect((persistedProfile?.openai as Record<string, unknown> | undefined)?.apiFormat).toBeUndefined()
			expect(persistedProfile?.usedFor).not.toContain("image")
			expect(persistedProfile).not.toHaveProperty("imageProfileId")
			const proofDir = path.join(process.cwd(), "tmp", "e2e-proof", "ws009-current-storage-proof")
			const screenshotPath = path.join(proofDir, "current-image-source-selected.png")
			const persistedProofPath = path.join(proofDir, "current-image-source-persisted.json")
			await mkdir(proofDir, { recursive: true })
			await profileCard.screenshot({ path: screenshotPath })
			await writeFile(
				persistedProofPath,
				`${JSON.stringify(
					{
						id: persistedProfile?.id,
						name: persistedProfile?.name,
						usedFor: persistedProfile?.usedFor,
						imageSource: persistedProfile?.imageSource,
						imageProfileId: persistedProfile?.imageProfileId,
						imageModelId: persistedProfile?.imageModelId,
					},
					null,
					2,
				)}\n`,
				"utf8",
			)
			await testInfo.attach("current-image-source-selected.png", { path: screenshotPath, contentType: "image/png" })
			await testInfo.attach("current-image-source-persisted.json", {
				path: persistedProofPath,
				contentType: "application/json",
			})
			await sidebar.getByRole("button", { name: "Done", exact: true }).click()
			await expect(sidebar.getByTestId("chat-input")).toBeVisible()
			await setImageAndProjectReadAutoApproval(sidebar)
			await sendTask(
				sidebar,
				"Generate one image with the GPT Subscription OpenAI Responses Profile, edit it using the returned ref, inspect the image from its returned path, and complete.",
			)
			const contextPath = await E2ETestHelper.waitForValue(async () => {
				const contextFiles = await findFiles(path.join(dlineDocsDir, "tasks"), "context.json")
				return contextFiles[0]
			}, 60_000)
			const taskDirectory = path.dirname(contextPath)
			const generatedArtifactHash = GENERATED_ARTIFACT_ID.replace("image:sha256:", "")
			const generatedImagePath = path.join(taskDirectory, "artifacts", "images", `${generatedArtifactHash}.png`)
			const initialContextContent = await readFile(contextPath)
			const initialContextProofPath = path.join(proofDir, "current-image-initial-context.json")
			await writeFile(initialContextProofPath, initialContextContent)
			await testInfo.attach("current-image-initial-context.json", {
				path: initialContextProofPath,
				contentType: "application/json",
			})
			const initialTaskContext = JSON.parse(initialContextContent.toString("utf8")) as {
				systemPrompt?: {
					frozen?: {
						tools?: unknown[] | null
						freshnessBaseline?: { imageGenerationAvailable?: boolean }
					}
				}
			}
			const initialFrozenTools = initialTaskContext.systemPrompt?.frozen?.tools ?? []
			expect(initialFrozenTools.map(getFrozenToolName)).toContain("generate_image")
			expect(initialTaskContext.systemPrompt?.frozen?.freshnessBaseline?.imageGenerationAvailable).toBe(true)
			await expect(sidebar.getByText("A hosted deterministic blue owl", { exact: true }).last()).toBeVisible({
				timeout: 60_000,
			})

			const partialPreview = sidebar.getByTestId("image-generation-partial-preview").last()
			await expect(partialPreview).toBeVisible({ timeout: 60_000 })
			const partialScreenshotPath = path.join(proofDir, "current-image-partial-preview.png")
			await partialPreview.screenshot({ path: partialScreenshotPath })
			await testInfo.attach("current-image-partial-preview.png", { path: partialScreenshotPath, contentType: "image/png" })

			await E2ETestHelper.waitUntil(
				async () => server.getMockConsumptions("openai-compatible-responses").length === 4,
				60_000,
			)
			const preReadConsumptions = server.getMockConsumptions("openai-compatible-responses")
			expect(preReadConsumptions.map((consumption) => consumption.responseType)).toEqual([
				"tool",
				"hosted-image-generation",
				"tool",
				"hosted-image-generation",
			])
			await expect(sidebar.getByText("Dline read 1 file:", { exact: false })).toHaveCount(0)
			const preReadTaskTextFiles = (await listFilesRecursively(taskDirectory)).filter((filePath) =>
				/\.(?:json|jsonl|md|txt)$/i.test(filePath),
			)
			const preReadTaskTextRecords = (
				await Promise.all(preReadTaskTextFiles.map((filePath) => readFile(filePath, "utf8")))
			).join("\n")
			expect(preReadTaskTextRecords).not.toContain(PNG_1X1_BASE64)
			expect(preReadTaskTextRecords).not.toContain("Successfully read image")
			expect(preReadTaskTextRecords).not.toMatch(/"record_source"\s*:\s*"read_tool"/)

			server.enqueueResponses(
				"openai-compatible-responses",
				{
					type: "tool",
					id: "call_read_current_image",
					name: "read_file",
					arguments: { path: generatedImagePath },
					expectedToolResults: [{ callId: "call_current_edit_image", contentIncludes: GENERATED_ARTIFACT_ID }],
					expectedRequestExcludes: [PNG_1X1_BASE64, "data:image/"],
				},
				{
					type: "tool",
					id: "call_current_image_done",
					name: "attempt_completion",
					arguments: { result: "E2E_CURRENT_IMAGE_OK" },
					expectedToolResults: [{ callId: "call_read_current_image", contentIncludes: "Successfully read image" }],
				},
			)

			await expect(sidebar.getByText("E2E_CURRENT_IMAGE_OK", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
			await expect(sidebar.getByText("Image generation completed", { exact: true }).last()).toBeVisible()
			await expect(sidebar.getByTestId("image-generation-partial-preview")).toHaveCount(0)
			const finalImage = sidebar.getByRole("img", { name: "Generated image 1" }).last()
			await expect(finalImage).toBeVisible({ timeout: 30_000 })
			await expect(finalImage.locator("..")).toHaveAttribute("style", /max-height:\s*60vh/)
			await expect(sidebar.getByTestId("image-generation-artifacts").last()).toHaveClass(/grid-cols-1/)
			await expect(sidebar.getByTestId("image-generation-artifacts").last()).not.toHaveClass(/sm:grid-cols-2/)
			const finalCard = finalImage.locator("xpath=../..")
			await expect(finalCard.getByRole("button", { name: "Fill image preview", exact: true })).toBeVisible()
			await expect(finalCard.getByRole("button", { name: "Copy Artifact ID", exact: true })).toBeVisible()
			await expect(finalCard.getByRole("button", { name: "Use as Reference", exact: true })).toBeVisible()
			const finalScreenshotPath = path.join(proofDir, "current-image-final-card.png")
			await finalCard.screenshot({ path: finalScreenshotPath })
			await testInfo.attach("current-image-final-card.png", { path: finalScreenshotPath, contentType: "image/png" })
			await finalCard.getByRole("button", { name: "Fill image preview", exact: true }).click()
			await expect(finalImage).toHaveAttribute("data-display-mode", "fill")
			await finalCard.getByRole("button", { name: "Keep image aspect ratio", exact: true }).click()
			await expect(finalImage).toHaveAttribute("data-display-mode", "fit")
			await finalCard.getByRole("button", { name: "Use as Reference", exact: true }).click()
			await expect(sidebar.getByTestId("chat-input")).toHaveValue(
				/^Use image artifact image:sha256:[a-f0-9]{64} as a reference for the next image generation\.\s*$/,
			)
			const consumptions = server.getMockConsumptions("openai-compatible-responses")
			expect(consumptions).toHaveLength(6)
			expect(consumptions.every((consumption) => consumption.contractError === undefined)).toBe(true)
			expect(consumptions.map((consumption) => consumption.responseType)).toEqual([
				"tool",
				"hosted-image-generation",
				"tool",
				"hosted-image-generation",
				"tool",
				"tool",
			])
			expect(JSON.stringify(consumptions[0].requestBody)).toContain('"name":"generate_image"')
			const generationRequest = consumptions[1].requestBody as {
				model?: string
				input?: Array<{ content?: Array<{ text?: string }> }>
				tools?: Array<Record<string, unknown>>
			}
			expect(generationRequest.model).toBe("gpt-5.6-sol")
			expect(generationRequest.tools?.[0]).toMatchObject({
				type: "image_generation",
				model: "gpt-image-2",
				action: "generate",
				partial_images: 3,
			})
			expect(generationRequest.tools?.[0]).not.toHaveProperty("size")
			expect(generationRequest.input?.[0]?.content?.[0]?.text).toBe("A hosted deterministic blue owl\n\n横版 16:9")
			expect(generationRequest).toMatchObject({ tool_choice: { type: "image_generation" }, store: false, stream: true })
			const firstToolResult = consumptions[2].requestToolResults.find(
				(entry) => entry.callId === "call_hosted_generate_image",
			)
			expect(firstToolResult?.content).toContain("reference_artifact_ids")
			expect(firstToolResult?.content).toContain(GENERATED_ARTIFACT_ID)
			expect(firstToolResult?.content).not.toContain(PNG_1X1_BASE64)
			expect(firstToolResult?.content).not.toContain("data:image/")
			const firstToolResultBlocks = JSON.parse(firstToolResult?.content ?? "[]") as Array<{ type?: string; text?: string }>
			const firstToolResultText = firstToolResultBlocks.find((block) => block.type === "text")?.text
			const firstToolResultPayload = JSON.parse(firstToolResultText?.split(" Result:\n")[1] ?? "{}") as {
				artifacts?: Array<{ id?: string; path?: string }>
			}
			expect(firstToolResultPayload.artifacts).toEqual([
				expect.objectContaining({ id: GENERATED_ARTIFACT_ID, path: generatedImagePath }),
			])
			const editRequest = consumptions[3].requestBody as {
				model?: string
				input?: unknown
				tools?: Array<Record<string, unknown>>
			}
			expect(editRequest.model).toBe("gpt-5.6-sol")
			expect(editRequest.tools?.[0]).toMatchObject({ type: "image_generation", model: "gpt-image-2", action: "edit" })
			expect(JSON.stringify(editRequest.input)).toContain('"type":"input_image"')
			const imageReadToolResult = consumptions[5].requestToolResults.find(
				(entry) => entry.callId === "call_read_current_image",
			)
			expect(imageReadToolResult?.content).toContain("Successfully read image")
			expect(await readFile(generatedImagePath)).toEqual(Buffer.from(PNG_1X1_BASE64, "base64"))
			const manifests = await findFiles(path.join(dlineDocsDir, "tasks"), "manifest.json")
			expect(manifests).toHaveLength(1)
			const manifest = await readFile(manifests[0], "utf8")
			expect(manifest).toContain("image:sha256:")
			expect(manifest).not.toContain(PNG_1X1_BASE64)
			expect(path.resolve(path.dirname(manifests[0]), "..")).toBe(taskDirectory)
			const requiredConversationArtifactNames = [
				"context.json",
				"api_conversation_history.jsonl",
				"ui_messages.jsonl",
			] as const
			const conversationArtifactNames = new Set([
				...requiredConversationArtifactNames,
				"context_history.jsonl",
				"api_conversation_all.jsonl",
			])
			const taskFiles = await listFilesRecursively(taskDirectory)
			for (const requiredName of requiredConversationArtifactNames) {
				expect(taskFiles.some((filePath) => path.basename(filePath) === requiredName)).toBe(true)
			}
			for (const artifactPath of taskFiles.filter((filePath) => conversationArtifactNames.has(path.basename(filePath)))) {
				const artifactName = path.basename(artifactPath)
				const artifactContent = await readFile(artifactPath)
				expect(artifactContent.toString("utf8")).not.toContain("dline-e2e-api-key")
				const proofPath = path.join(proofDir, `current-image-${artifactName}`)
				await writeFile(proofPath, artifactContent)
				await testInfo.attach(`current-image-${artifactName}`, {
					path: proofPath,
					contentType: artifactName.endsWith(".json") ? "application/json" : "application/x-ndjson",
				})
			}
			const taskTextFiles = (await listFilesRecursively(taskDirectory)).filter((filePath) =>
				/\.(?:json|jsonl|md|txt)$/i.test(filePath),
			)
			const taskTextRecords = (await Promise.all(taskTextFiles.map((filePath) => readFile(filePath, "utf8")))).join("\n")
			expect(taskTextRecords).not.toContain("data:image/")
			expect(taskTextRecords).not.toContain("partial_image_b64")
			expect(taskTextRecords).not.toContain("dline-e2e-api-key")
			expect(await listFilesRecursively(path.join(taskDirectory, "tmp", "image-previews"))).toHaveLength(1)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)
