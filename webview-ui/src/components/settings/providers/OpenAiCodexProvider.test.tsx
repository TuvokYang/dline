import {
	type OpenAiCodexAuthFlow,
	OpenAiCodexAuthStatus,
	OpenAiCodexBrowserOpenStatus,
	OpenAiCodexFlowStatus,
} from "@shared/proto/dline/account"
import { ApiProfile } from "@shared/proto/dline/profile"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { OpenAiCodexProvider } from "./OpenAiCodexProvider"

const mocks = vi.hoisted(() => ({
	getStatus: vi.fn(),
	signIn: vi.fn(),
	complete: vi.fn(),
	importOAuthJson: vi.fn(),
	cancel: vi.fn(),
	signOut: vi.fn(),
	getUsage: vi.fn(),
	consumeResetCredit: vi.fn(),
	copyToClipboard: vi.fn(),
	openInBrowser: vi.fn(),
}))

vi.mock("@/services/grpc-client", () => ({
	AccountServiceClient: {
		getOpenAiCodexAuthStatus: mocks.getStatus,
		startOpenAiCodexSignIn: mocks.signIn,
		completeOpenAiCodexCallbackUri: mocks.complete,
		importOpenAiCodexCredentialJson: mocks.importOAuthJson,
		cancelOpenAiCodexSignIn: mocks.cancel,
		signOutOpenAiCodexProfile: mocks.signOut,
		getProviderUsage: mocks.getUsage,
		consumeAccountUsageResetCredit: mocks.consumeResetCredit,
	},
	FileServiceClient: { copyToClipboard: mocks.copyToClipboard },
	WebServiceClient: { openInBrowser: mocks.openInBrowser },
}))

// The usage panel shows the snapshot the Controller published before reading
// on its own, so it needs the shared state this test does not otherwise mount.
vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ accountUsage: undefined }),
}))

vi.mock("./useProviderModelOptions", () => ({
	useProviderModelOptions: () => ({
		models: {},
		defaultModelId: "gpt-5-codex",
		modelInfoSaneDefaults: {},
		options: {},
		refreshRemoteModels: vi.fn(),
	}),
}))

const profile = ApiProfile.create({
	id: "profile-a",
	name: "Codex A",
	provider: "openai-codex",
	modelId: "gpt-5-codex",
	enabled: true,
})

function renderProvider() {
	return render(<OpenAiCodexProvider onUpdate={vi.fn()} profile={profile} showModelOptions={false} />)
}

const profileB = ApiProfile.create({ ...profile, id: "profile-b", name: "Codex B" })

const activeFlow: OpenAiCodexAuthFlow = {
	profileId: profile.id,
	flowId: "flow-a",
	authorizationUrl:
		"https://auth.example.test/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=transient-state",
	redirectUri: "http://localhost:1455/auth/callback",
	expiresAtMs: Date.now() + 300_000,
	browserOpenStatus: OpenAiCodexBrowserOpenStatus.OPEN_AI_CODEX_BROWSER_OPEN_STATUS_OPENED,
}

describe("OpenAiCodexProvider OAUTH control", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.getStatus.mockResolvedValue({
			profileId: profile.id,
			status: OpenAiCodexAuthStatus.OPEN_AI_CODEX_AUTH_STATUS_MISSING,
		})
		mocks.signIn.mockResolvedValue(activeFlow)
		mocks.complete.mockResolvedValue({
			profileId: profile.id,
			status: OpenAiCodexAuthStatus.OPEN_AI_CODEX_AUTH_STATUS_AUTHENTICATED,
		})
		mocks.importOAuthJson.mockResolvedValue({
			profileId: profile.id,
			status: OpenAiCodexAuthStatus.OPEN_AI_CODEX_AUTH_STATUS_AUTHENTICATED,
		})
		mocks.cancel.mockResolvedValue({})
		mocks.signOut.mockResolvedValue({})
		mocks.getUsage.mockResolvedValue({
			profileId: profile.id,
			providerId: "openai-codex",
			currency: "",
			planType: "pro",
			quotas: [
				{
					type: "weekly",
					label: "7 day",
					used: 83,
					limit: 100,
					windowSeconds: 604_800,
					resetAt: new Date(1_900_500_000_000).toISOString(),
				},
			],
			resetCreditsAvailableCount: 1,
			resetCredits: [{ id: "credit-a", expiresAt: new Date(1_900_750_000_000).toISOString() }],
			allowed: true,
			limitReached: false,
			isAvailable: true,
		})
		mocks.consumeResetCredit.mockResolvedValue({ profileId: profile.id, outcome: 1, windowsReset: ["primary"] })
		mocks.copyToClipboard.mockResolvedValue({})
		mocks.openInBrowser.mockResolvedValue({})
	})

	it("keeps the Provider card compact and free of manual credential inputs", async () => {
		renderProvider()
		await waitFor(() => expect(mocks.getStatus).toHaveBeenCalledWith({ profileId: "profile-a" }))
		expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument()
		expect(screen.queryByText(/Manual input/i)).not.toBeInTheDocument()
		expect(screen.queryByLabelText(/api key|access token|refresh token|oauth json/i)).not.toBeInTheDocument()
	})

	it("shows the signed-in ChatGPT account name and email", async () => {
		mocks.getStatus.mockResolvedValue({
			profileId: profile.id,
			status: OpenAiCodexAuthStatus.OPEN_AI_CODEX_AUTH_STATUS_AUTHENTICATED,
			account: {
				accountId: "account-a",
				displayName: "Ada Lovelace",
				email: "ada@example.test",
				accountType: "pro",
				expiresAtMs: 1_900_000_000_000,
			},
		})

		renderProvider()

		expect(await screen.findByText("Ada Lovelace")).toBeInTheDocument()
		expect(screen.getByText("ada@example.test")).toBeInTheDocument()
		expect(screen.getByText("Pro")).toBeInTheDocument()
		const accountDetails = screen.getByLabelText("Signed-in ChatGPT account")
		expect(accountDetails).toBeInTheDocument()
		expect(within(accountDetails).getByText(/^Sign-in expires /)).toBeInTheDocument()
		expect(within(accountDetails).getByText("Usage")).toBeInTheDocument()
		const accountCard = accountDetails.parentElement
		const signInAgain = screen.getByRole("button", { name: "Sign in again" })
		const signOut = screen.getByRole("button", { name: "Sign out" })
		expect(accountCard).toContainElement(signInAgain)
		expect(accountCard).toContainElement(signOut)
		expect(signInAgain).toHaveClass("bg-button-background")
		expect(signOut).toHaveClass("text-error")
		// The Controller reads usage once when the Profile becomes active. The
		// panel remounts on every expand and tab switch, so it shows that
		// snapshot and reads only when the user refreshes.
		expect(mocks.getUsage).not.toHaveBeenCalled()
	})

	it("opens the OAUTH dialog immediately and then shows the transient authorization URI", async () => {
		let resolveFlow!: (flow: OpenAiCodexAuthFlow) => void
		mocks.signIn.mockReturnValue(new Promise((resolve) => (resolveFlow = resolve)))
		renderProvider()
		fireEvent.click(await screen.findByRole("button", { name: "Sign in" }))

		expect(screen.getByRole("dialog", { name: "Sign in to ChatGPT" })).toBeInTheDocument()
		expect(screen.getByText("Generating the sign-in URL…")).toBeInTheDocument()
		await act(async () => resolveFlow(activeFlow))
		expect(await screen.findByLabelText("ChatGPT sign-in URL")).toHaveValue(activeFlow.authorizationUrl)
		expect(screen.queryByText(/callback listener/i)).not.toBeInTheDocument()
		expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument()
		expect(screen.getByRole("button", { name: "Finish sign-in" })).toBeInTheDocument()
	})

	it("copies and reopens the displayed authorization URI through host RPCs", async () => {
		renderProvider()
		fireEvent.click(await screen.findByRole("button", { name: "Sign in" }))
		await screen.findByLabelText("ChatGPT sign-in URL")

		fireEvent.click(screen.getByRole("button", { name: "Copy sign-in URL" }))
		await waitFor(() =>
			expect(mocks.copyToClipboard).toHaveBeenCalledWith(expect.objectContaining({ value: activeFlow.authorizationUrl })),
		)
		fireEvent.click(screen.getByRole("button", { name: "Open in browser again" }))
		await waitFor(() =>
			expect(mocks.openInBrowser).toHaveBeenCalledWith(expect.objectContaining({ value: activeFlow.authorizationUrl })),
		)
	})

	it("submits the callback owner, clears the URI before settle, and closes automatically", async () => {
		let resolveCompletion!: (value: object) => void
		const completion = new Promise((resolve) => (resolveCompletion = resolve))
		mocks.complete.mockReturnValue(completion)
		renderProvider()
		fireEvent.click(await screen.findByRole("button", { name: "Sign in" }))
		const input = await screen.findByRole("textbox", { name: "Full callback URL" })
		const callbackUri = "http://localhost:1455/auth/callback?code=secret-code&state=secret-state"
		fireEvent.change(input, { target: { value: callbackUri } })
		fireEvent.click(screen.getByRole("button", { name: "Finish sign-in" }))

		expect(mocks.complete).toHaveBeenCalledWith({ profileId: "profile-a", flowId: "flow-a", callbackUri })
		expect(input).toHaveValue("")
		await act(async () => {
			resolveCompletion({ profileId: profile.id, status: OpenAiCodexAuthStatus.OPEN_AI_CODEX_AUTH_STATUS_AUTHENTICATED })
			await completion
		})
		await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
	})

	it("keeps OAuth JSON collapsed and compact, clears it before settle, and closes on success", async () => {
		let resolveImport!: (value: object) => void
		const request = new Promise((resolve) => (resolveImport = resolve))
		mocks.importOAuthJson.mockReturnValue(request)
		renderProvider()
		fireEvent.click(await screen.findByRole("button", { name: "Sign in" }))
		await screen.findByLabelText("ChatGPT sign-in URL")
		expect(screen.queryByRole("textbox", { name: "OpenAI Codex OAuth JSON" })).not.toBeInTheDocument()

		fireEvent.click(screen.getByRole("button", { name: /Advanced: import OAuth credential JSON/ }))
		const input = screen.getByRole("textbox", { name: "OpenAI Codex OAuth JSON" })
		expect(input).toHaveClass("h-24", "max-h-24")
		const oauthJson = JSON.stringify({ access_token: "manual-secret", expires: 1_900_000_000_000 })
		fireEvent.change(input, { target: { value: oauthJson } })
		fireEvent.click(screen.getByRole("button", { name: "Import credential" }))
		expect(mocks.importOAuthJson).toHaveBeenCalledWith({ profileId: "profile-a", oauthJson })
		expect(input).toHaveValue("")

		await act(async () => {
			resolveImport({ profileId: profile.id, status: OpenAiCodexAuthStatus.OPEN_AI_CODEX_AUTH_STATUS_AUTHENTICATED })
			await request
		})
		await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
	})

	it("shows an explicit timeout and replaces completion with restart", async () => {
		mocks.getStatus.mockResolvedValue({
			profileId: profile.id,
			status: OpenAiCodexAuthStatus.OPEN_AI_CODEX_AUTH_STATUS_MISSING,
			activeFlow: { ...activeFlow, flowId: "expired-flow", expiresAtMs: Date.now() - 1 },
			lastFlowOutcome: {
				profileId: profile.id,
				flowId: "expired-flow",
				status: OpenAiCodexFlowStatus.OPEN_AI_CODEX_FLOW_STATUS_TIMED_OUT,
				endedAtMs: Date.now(),
			},
		})
		renderProvider()
		expect(await screen.findByText("This sign-in timed out. Start again.")).toBeInTheDocument()
		expect(screen.getByRole("textbox", { name: "Full callback URL" })).toBeDisabled()
		expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument()
	})

	it("explains lazy automatic refresh without exposing a Refresh button", async () => {
		mocks.getStatus.mockResolvedValue({
			profileId: profile.id,
			status: OpenAiCodexAuthStatus.OPEN_AI_CODEX_AUTH_STATUS_REFRESHABLE_EXPIRED,
		})
		renderProvider()
		expect(await screen.findByText("ChatGPT: Signed in · refreshing")).toBeInTheDocument()
		expect(screen.queryByRole("button", { name: /^refresh$/i })).not.toBeInTheDocument()
	})

	it("cancels only the active Profile flow and signs out only the authenticated Profile", async () => {
		renderProvider()
		fireEvent.click(await screen.findByRole("button", { name: "Sign in" }))
		await screen.findByLabelText("ChatGPT sign-in URL")
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
		await waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith({ profileId: "profile-a", flowId: "flow-a" }))

		mocks.getStatus.mockResolvedValue({
			profileId: profile.id,
			status: OpenAiCodexAuthStatus.OPEN_AI_CODEX_AUTH_STATUS_AUTHENTICATED,
		})
		renderProvider()
		fireEvent.click(await screen.findByRole("button", { name: "Sign out" }))
		await waitFor(() => expect(mocks.signOut).toHaveBeenCalledWith({ profileId: "profile-a" }))
	})

	it("keeps reauthentication open when the existing credential is authenticated and a new flow is active", async () => {
		mocks.getStatus.mockResolvedValue({
			profileId: profile.id,
			status: OpenAiCodexAuthStatus.OPEN_AI_CODEX_AUTH_STATUS_AUTHENTICATED,
		})
		renderProvider()
		fireEvent.click(await screen.findByRole("button", { name: "Sign in again" }))
		await screen.findByLabelText("ChatGPT sign-in URL")

		mocks.getStatus.mockResolvedValue({
			profileId: profile.id,
			status: OpenAiCodexAuthStatus.OPEN_AI_CODEX_AUTH_STATUS_AUTHENTICATED,
			activeFlow,
		})
		await waitFor(() => expect(mocks.getStatus.mock.calls.length).toBeGreaterThan(1), { timeout: 2_500 })

		expect(screen.getByRole("dialog", { name: "Sign in to ChatGPT" })).toBeInTheDocument()
		expect(screen.getByLabelText("ChatGPT sign-in URL")).toHaveValue(activeFlow.authorizationUrl)
	})

	it("cancels a late start response with its original owner after the Profile changes", async () => {
		let resolveFlow!: (flow: OpenAiCodexAuthFlow) => void
		mocks.signIn.mockReturnValue(new Promise((resolve) => (resolveFlow = resolve)))
		mocks.getStatus.mockImplementation(({ profileId }: { profileId: string }) =>
			Promise.resolve({ profileId, status: OpenAiCodexAuthStatus.OPEN_AI_CODEX_AUTH_STATUS_MISSING }),
		)
		const view = renderProvider()
		fireEvent.click(await screen.findByRole("button", { name: "Sign in" }))

		view.rerender(<OpenAiCodexProvider onUpdate={vi.fn()} profile={profileB} showModelOptions={false} />)
		await act(async () => resolveFlow(activeFlow))

		await waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith({ profileId: "profile-a", flowId: "flow-a" }))
		expect(screen.queryByDisplayValue(activeFlow.authorizationUrl)).not.toBeInTheDocument()
	})

	it("cancels a late start response after the Provider unmounts", async () => {
		let resolveFlow!: (flow: OpenAiCodexAuthFlow) => void
		mocks.signIn.mockReturnValue(new Promise((resolve) => (resolveFlow = resolve)))
		const view = renderProvider()
		fireEvent.click(await screen.findByRole("button", { name: "Sign in" }))
		view.unmount()

		await act(async () => resolveFlow(activeFlow))

		await waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith({ profileId: "profile-a", flowId: "flow-a" }))
	})

	it("projects a terminal flow failure and removes the stale authorization URI", async () => {
		mocks.complete.mockResolvedValue({
			profileId: profile.id,
			status: OpenAiCodexAuthStatus.OPEN_AI_CODEX_AUTH_STATUS_MISSING,
			lastFlowOutcome: {
				profileId: profile.id,
				flowId: activeFlow.flowId,
				status: OpenAiCodexFlowStatus.OPEN_AI_CODEX_FLOW_STATUS_FAILED,
				endedAtMs: Date.now(),
			},
		})
		renderProvider()
		fireEvent.click(await screen.findByRole("button", { name: "Sign in" }))
		const input = await screen.findByRole("textbox", { name: "Full callback URL" })
		fireEvent.change(input, { target: { value: "http://localhost:1455/auth/callback?code=denied&state=state" } })
		fireEvent.click(screen.getByRole("button", { name: "Finish sign-in" }))

		expect(await screen.findByText("Sign-in failed. Try again.")).toBeInTheDocument()
		expect(screen.queryByLabelText("ChatGPT sign-in URL")).not.toBeInTheDocument()
		expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument()
	})

	it("never renders raw start or import error payloads", async () => {
		const secret = "access_token=secret-token&code=secret-code"
		mocks.signIn.mockRejectedValue(new Error(secret))
		renderProvider()
		fireEvent.click(await screen.findByRole("button", { name: "Sign in" }))
		await screen.findByText("Cannot start the ChatGPT sign-in. Try again.")
		expect(document.body.textContent).not.toContain(secret)
	})
})
