import { type BrowserAction, browserActions, type UiMessage } from "@shared/ExtensionMessage"

export interface BrowserSessionState {
	url?: string
	screenshot?: string
	mousePosition?: string
	consoleLogs?: string
}

export interface BrowserSessionAction {
	messageTs: number
	action: BrowserAction
	coordinate?: string
	text?: string
}

export interface BrowserSessionPage {
	state: BrowserSessionState
	actions: BrowserSessionAction[]
}

export interface BrowserSessionProjection {
	pages: BrowserSessionPage[]
	conversationMessages: UiMessage[]
	initialUrl: string
	isAutoApproved: boolean
	hasBrowserResult: boolean
}

function parseRecord(text: string | undefined): Record<string, unknown> | undefined {
	if (!text) return undefined
	try {
		const value: unknown = JSON.parse(text)
		return typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined
	} catch {
		return undefined
	}
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined
}

function parseResult(message: UiMessage): BrowserSessionState {
	const result = parseRecord(message.text)
	return {
		url: optionalString(result?.currentUrl),
		screenshot: optionalString(result?.screenshot),
		mousePosition: optionalString(result?.currentMousePosition),
		consoleLogs: optionalString(result?.logs),
	}
}

function parseAction(message: UiMessage): BrowserSessionAction | undefined {
	const value = parseRecord(message.text)
	const action = optionalString(value?.action)
	if (!action || !browserActions.includes(action as BrowserAction)) return undefined
	return {
		messageTs: message.ts,
		action: action as BrowserAction,
		coordinate: optionalString(value?.coordinate),
		text: optionalString(value?.text),
	}
}

export function hasCancelledBrowserApiRequest(messages: UiMessage[]): boolean {
	const lastApiRequest = [...messages].reverse().find((message) => message.say === "api_req_started")
	const value = parseRecord(lastApiRequest?.text)
	return value?.cancelReason !== undefined && value.cancelReason !== null
}

export function projectBrowserSession(messages: UiMessage[]): BrowserSessionProjection {
	const pages: BrowserSessionPage[] = []
	const conversationMessages: UiMessage[] = []
	let pendingActions: BrowserSessionAction[] = []
	let initialUrl = ""
	let isAutoApproved = false
	let hasLaunch = false
	let hasBrowserResult = false

	for (const message of messages) {
		if (message.ask === "browser_action_launch" || message.say === "browser_action_launch") {
			hasLaunch = true
			initialUrl = message.text ?? ""
			isAutoApproved = message.say === "browser_action_launch"
			continue
		}

		if (message.say === "browser_action") {
			const action = parseAction(message)
			if (action) pendingActions.push(action)
			continue
		}

		if (message.say === "browser_action_result") {
			hasBrowserResult = true
			if (message.text === "") continue
			pages.push({ state: parseResult(message), actions: pendingActions })
			pendingActions = []
			continue
		}

		conversationMessages.push(message)
	}

	if (pages.length === 0 || pendingActions.length > 0) {
		pages.push({ state: {}, actions: pendingActions })
	}

	return {
		pages: hasLaunch || hasBrowserResult ? pages : [],
		conversationMessages,
		initialUrl,
		isAutoApproved,
		hasBrowserResult,
	}
}
