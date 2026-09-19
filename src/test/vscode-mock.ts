// Mock implementation of VSCode API for unit tests
import * as fs from "node:fs/promises"

type MockUri = {
	fsPath: string
	scheme?: string
	toString: () => string
}

class MockTextDocument {
	public isDirty = false
	private content: string

	constructor(
		public uri: MockUri,
		content = "",
	) {
		this.content = content
	}

	getText() {
		return this.content
	}

	insert(_position: Position, text: string) {
		this.content = `${text}${this.content}`
		this.isDirty = true
	}

	async save() {
		if (this.uri.scheme !== "untitled") {
			await fs.writeFile(this.uri.fsPath, this.content, "utf8")
		}
		this.isDirty = false
		return true
	}
}

const textDocuments: MockTextDocument[] = []
const visibleEditorsByColumn = new Map<number, any>()
const tabsByColumn = new Map<number, any[]>()

function toUri(input: string | MockUri): MockUri {
	if (typeof input !== "string") {
		return input
	}
	return Uri.file(input)
}

function findDocument(uri: MockUri) {
	return textDocuments.find((document) => document.uri.fsPath === uri.fsPath)
}

function updateVisibleEditors() {
	window.visibleTextEditors = [...visibleEditorsByColumn.values()]
}

function updateTabGroups() {
	window.tabGroups.all = [...tabsByColumn.entries()].map(([viewColumn, tabs]) => ({ viewColumn, tabs }))
}

function closeAllEditors() {
	textDocuments.length = 0
	visibleEditorsByColumn.clear()
	tabsByColumn.clear()
	updateVisibleEditors()
	updateTabGroups()
}

export const env = {
	machineId: "test-machine-id",
	appName: "VS Code",
	remoteName: undefined as string | undefined,
	isTelemetryEnabled: true,
	onDidChangeTelemetryEnabled: (_callback: (enabled: boolean) => void) => {
		// Return a disposable mock
		return {
			dispose: () => {},
		}
	},
}

export const version = "1.103.0"

export const workspace = {
	textDocuments,
	onDidChangeConfiguration: (
		_listener: (event: unknown) => void,
		_thisArg?: unknown,
		disposables?: Array<{ dispose(): void }>,
	) => {
		const disposable = { dispose: () => undefined }
		disposables?.push(disposable)
		return disposable
	},
	async openTextDocument(input: string | MockUri) {
		const uri = toUri(input)
		const existingDocument = findDocument(uri)
		if (existingDocument) {
			return existingDocument
		}

		let content = ""
		if (uri.scheme !== "untitled") {
			try {
				content = await fs.readFile(uri.fsPath, "utf8")
			} catch {
				content = ""
			}
		}

		const document = new MockTextDocument(uri, content)
		textDocuments.push(document)
		return document
	},
	async applyEdit(edit: WorkspaceEdit) {
		for (const item of edit.edits) {
			const document = findDocument(item.uri)
			document?.insert(item.position, item.text)
		}
		return true
	},
	getConfiguration: (section?: string) => {
		return {
			get: (key: string, defaultValue?: any) => {
				// Return default values for common configuration keys
				if (section === "cline" && (key === "usageReportingSetting" || key === "errorReportingSetting")) {
					return "enabled"
				}
				if (section === "telemetry" && key === "telemetryLevel") {
					return "all"
				}
				return defaultValue
			},
		}
	},
}

// Export other commonly used VSCode API mocks as needed
export const window = {
	visibleTextEditors: [] as any[],
	tabGroups: {
		all: [] as any[],
	},
	showErrorMessage: (_message: string) => Promise.resolve(),
	showWarningMessage: (_message: string) => Promise.resolve(),
	showInformationMessage: (_message: string) => Promise.resolve(),
	createTextEditorDecorationType: (_options: any) => ({
		key: "mock-decoration-type",
		dispose: () => {},
	}),
	createTerminal: (_opts: any) => ({
		name: (_opts && _opts.name) || "Test Terminal",
		processId: Promise.resolve(1),
		sendText: () => {},
		show: () => {},
		hide: () => {},
		dispose: () => {},
		creationOptions: _opts || {},
		exitStatus: undefined,
		shellPath: _opts && _opts.shellPath,
		shellArgs: _opts && _opts.shellArgs,
		get shellIntegration() {
			return undefined
		},
		onDidWriteData: () => ({ dispose: () => {} }),
		onDidClose: () => ({ dispose: () => {} }),
		onDidExitTerminal: () => ({ dispose: () => {} }),
	}),
	async showTextDocument(document: MockTextDocument, options: any = {}) {
		const viewColumn = options.viewColumn ?? ViewColumn.One
		const editor = {
			document,
			viewColumn,
			async edit(callback: (editBuilder: { insert(position: Position, text: string): void }) => void) {
				callback({
					insert(position: Position, text: string) {
						document.insert(position, text)
					},
				})
				return true
			},
		}

		visibleEditorsByColumn.set(viewColumn, editor)
		const tabs = tabsByColumn.get(viewColumn) ?? []
		if (!tabs.some((tab) => tab.input?.uri?.fsPath === document.uri.fsPath)) {
			tabs.push({ input: new TabInputText(document.uri) })
			tabsByColumn.set(viewColumn, tabs)
		}
		updateVisibleEditors()
		updateTabGroups()
		return editor
	},
	createWebviewPanel: (_viewType: string, _title: string, _showOptions: any, _options: any) => {
		const listeners: Set<(msg: any) => void> = new Set()
		return {
			webview: {
				html: "",
				onDidReceiveMessage: (listener: (msg: any) => void) => {
					listeners.add(listener)
					return { dispose: () => listeners.delete(listener) }
				},
				postMessage: (msg: any) => {
					setTimeout(() => {
						for (const listener of listeners) {
							listener(msg)
						}
					}, 0)
				},
				asWebviewUri: (uri: any) => uri,
				cspSource: "",
			},
			onDidDispose: () => ({ dispose: () => {} }),
			dispose: () => {},
			reveal: () => {},
			visible: true,
			viewType: _viewType,
			title: _title,
		}
	},
	createOutputChannel: (_name: string) => ({
		appendLine: (message: string) => console.debug(message),
		append: (message: string) => console.debug(message),
		clear: () => {},
		show: () => {},
		hide: () => {},
		dispose: () => {},
	}),
}

export const commands = {
	executeCommand: (command: string, ..._args: any[]) => {
		if (command === "workbench.action.closeAllEditors") {
			closeAllEditors()
		}
		return Promise.resolve()
	},
}

export const Uri = {
	file: (path: string) => ({ fsPath: path, scheme: "file", toString: () => path }),
	parse: (uri: string) => ({
		fsPath: uri,
		scheme: uri.startsWith("untitled:") ? "untitled" : undefined,
		toString: () => uri,
	}),
}

export const ExtensionContextMock = {}
export const StatusBarAlignmentMock = { Left: 1, Right: 2 }
export const ViewColumnMock = { One: 1, Two: 2, Three: 3 }
export const extensions = {
	getExtension: (id: string) => ({
		id,
		packageJSON: { version: "0.0.0" },
		exports: {},
		extensionPath: "/mock",
		activate: async () => ({}),
		isActive: true,
	}),
}
export const ViewColumn = { One: 1, Two: 2, Three: 3 }
export class Position {
	constructor(
		public line: number,
		public character: number,
	) {}
}
export class Range {
	public start: Position
	public end: Position

	constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
		this.start = new Position(startLine, startCharacter)
		this.end = new Position(endLine, endCharacter)
	}
}
export class WorkspaceEdit {
	public edits: Array<{ uri: MockUri; position: Position; text: string }> = []

	insert(uri: MockUri, position: Position, text: string) {
		this.edits.push({ uri, position, text })
	}
}
export const DiagnosticSeverity = {
	Error: 0,
	Warning: 1,
	Information: 2,
	Hint: 3,
}
export class Diagnostic {
	public source?: string

	constructor(
		public range: Range,
		public message: string,
		public severity: number,
	) {}
}
export class TabInputText {
	constructor(public uri: MockUri) {}
}
export const languages = {
	getDiagnostics: () => [] as Array<[MockUri, Diagnostic[]]>,
}
export class ThemeIcon {
	constructor(public id: string) {}
}
export const LanguageModelChatMessageRole = {
	User: 1,
	Assistant: 2,
	System: 3,
}
export class LanguageModelChatMessage {
	constructor(
		public role: number,
		public content: Array<LanguageModelTextPart | LanguageModelToolCallPart | LanguageModelToolResultPart>,
	) {}
	static User(content: string | Array<LanguageModelTextPart | LanguageModelToolResultPart>) {
		return new LanguageModelChatMessage(1, typeof content === "string" ? [new LanguageModelTextPart(content)] : content)
	}
	static Assistant(content: string | Array<LanguageModelTextPart | LanguageModelToolCallPart>) {
		return new LanguageModelChatMessage(2, typeof content === "string" ? [new LanguageModelTextPart(content)] : content)
	}
}
export class LanguageModelTextPart {
	constructor(public value: string) {}
}
export class LanguageModelToolCallPart {
	constructor(
		public callId: string,
		public name: string,
		public input: any,
	) {}
}
export class LanguageModelPromptTsxPart {
	constructor(public value: unknown) {}
}
export class LanguageModelToolResultPart {
	constructor(
		public callId: string,
		public content: Array<LanguageModelTextPart | LanguageModelPromptTsxPart | unknown>,
	) {}
}
export const lm = {
	selectChatModels: async () => [{ id: "test-lm", vendor: "copilot", family: "gpt-4o" }],
	sendChatRequest: async (_models: any[], _messages: any[], _options: any) => ({ messages: [] }),
}
